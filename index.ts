/**
 * pi-a6api-provider — A6API provider support and model catalog browser.
 *
 * Provider: registers `a6api` (OpenAI-compatible gateway at
 * https://api.a6api.vip/v1) with a catalog discovered from the gateway, so the
 * models appear in `/model`, `Ctrl+P` and `/models` like a built-in provider,
 * priced in the footer and in `/session`.
 *
 * Failover: the gateway publishes its edges in `GET /api/status` (`api_info`).
 * When three requests in a row cannot reach the model, the provider re-registers
 * itself on the next edge and remembers the choice in `a6api-endpoint.json`; a
 * later start goes back to the primary once it answers again.
 *
 * Data flow follows pi-anymodel-provider: one `fetchCatalogPayload()` per refresh, one
 * raw snapshot on disk, `loadCatalogFromDisk()` before the provider registers,
 * and a TTL check so a session does not re-fetch a fresh catalog.
 *
 * Info: `/a6api` opens a searchable model browser (price, cache price,
 * long-context tiers, context/output limits, vendor, gateway groups), plus
 * `/a6api list`, `/a6api <model>`, `/a6api endpoint`, and `/a6api refresh`.
 *
 * Usage: pi --extension ~/.pi/agent/extensions/pi-a6api-provider
 */

import { createProvider, envApiKeyAuth, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ENV_VARS,
	PROVIDER_ID,
	PROVIDER_NAME,
	chatModels,
	catalogTtlMs,
	fetchCatalogPayload,
	getCatalog,
	getCatalogModel,
	getGatewayEndpoints,
	getGroupRatio,
	getPricingVersion,
	loadCatalogFromDisk,
	parseCatalog,
	setCatalog,
	snapshotAgeMs,
	snapshotWriteCount,
	snapshotPath,
	toModel,
	writeSnapshotPayload,
	type CatalogModel,
} from "./catalog.ts";
import { loadConfig, primaryBaseUrl, resolveBaseUrl } from "./config.ts";
import {
	FAILOVER_AFTER,
	clearEndpointState,
	endpointCandidates,
	endpointHost,
	isUnreachableFailure,
	probeEndpoint,
	readEndpointState,
	refreshEndpointState,
	rotationFrom,
	withV1,
	writeEndpointState,
} from "./endpoints.ts";
import { describeLines, formatTokens, formatUsd, summaryLines, tableLines } from "./info.ts";
import { A6ApiPickerComponent } from "./picker.ts";
import { TextViewComponent } from "./text-view.ts";

const STATUS_KEY = "pi-a6api";
const CATALOG_REFRESH_TIMEOUT_MS = 8_000;
const CATALOG_REFRESH_ATTEMPTS = 3;
const CATALOG_REFRESH_RETRY_MS = 600;

/** A refresh can outlive its session (print mode exits fast); stale ctx must not throw. */
let sessionActive = false;

/**
 * Set by the factory so failover can re-register the provider from event
 * handlers. It can go stale: pi replaces the extension runtime on /reload or a
 * session switch and then rejects every call on the old object.
 */
let registeredPi: ExtensionAPI | undefined;

/** Bumped per extension instance; async work from an older one must not touch pi. */
let runtimeGeneration = 0;

/** Unreachable answers since the last successful one, in this process. */
let unreachableStreak = 0;

/** One rotation at a time: a retry storm must not walk the whole edge list. */
let failoverInFlight = false;

export default function a6apiExtension(pi: ExtensionAPI): void {
	runtimeGeneration += 1;
	const generation = runtimeGeneration;
	registeredPi = pi;
	const debug = (message: string): void => {
		if (process.env.A6API_DEBUG) console.error(`[a6api] ${message}`);
	};

	/** Startup catalog refresh runs once per extension instance (i.e. per pi launch). */
	let startupRefreshDone = false;

	const loaded = loadCatalogFromDisk();
	pi.registerProvider(buildProvider());
	debug(`provider registered with ${loaded} models from ${snapshotPath()}`);

	pi.on("session_start", async (_event, ctx) => {
		if (generation !== runtimeGeneration) return;
		sessionActive = true;
		// Another process may have switched the edge or refreshed the snapshot.
		refreshEndpointState();
		loadCatalogFromDisk();
		renderStatus(ctx);
		if (!startupRefreshDone) {
			startupRefreshDone = true;
			void (async () => {
				await returnToPrimary(ctx);
				await refreshCatalog(ctx);
			})();
		}
	});

	// Every failed attempt passes through here, retries included: three
	// unreachable answers in a row mean this edge is not usable.
	pi.on("message_end", (event, ctx) => {
		if (generation !== runtimeGeneration) return;
		const message = event.message;
		if (message.role !== "assistant" || message.provider !== PROVIDER_ID) return;
		if (message.stopReason !== "error") {
			unreachableStreak = 0;
			return;
		}
		const config = loadConfig();
		if (config.failover === false || !isUnreachableFailure(message)) return;
		unreachableStreak += 1;
		const after = config.failoverAfter ?? FAILOVER_AFTER;
		debug(`unreachable ${unreachableStreak}/${after}: ${message.errorMessage ?? ""}`);
		if (unreachableStreak < after || failoverInFlight) return;
		unreachableStreak = 0;
		void failoverEndpoint(ctx, `failover after ${after} unreachable requests`, generation);
	});

	pi.on("model_select", async (_event, ctx) => {
		renderStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (generation !== runtimeGeneration) return;
		sessionActive = false;
		renderStatus(ctx, { clear: true });
	});

	pi.registerCommand("a6api", {
		description: "A6API: browse models, prices, and limits",
		getArgumentCompletions: (prefix) => {
			const commands = [
				{ value: "list", label: "list [filter]", description: "Print the model table" },
				{ value: "refresh", label: "refresh", description: "Reload /v1/models and /api/pricing" },
				{ value: "endpoint", label: "endpoint [n|url|reset]", description: "Show or pin the gateway edge" },
			];
			const ids = getCatalog()
				.filter((model) => !model.hidden)
				.slice(0, 200)
				.map((model) => ({
					value: model.id,
					label: model.id,
					description: `${formatUsd(model.cost.input)} / ${formatUsd(model.cost.output)} per 1M · ${model.kind}`,
				}));
			return [...commands, ...ids].filter((item) => item.value.startsWith(prefix)).slice(0, 50);
		},
		handler: async (args, ctx) => handleCommand(args, ctx, pi),
	});
}

// ─── Provider ────────────────────────────────────────────────────────

function providerModels() {
	const baseUrl = resolveBaseUrl(loadConfig());
	return chatModels(getCatalog()).map((model) => toModel(model, baseUrl));
}

/** Chat models pi restored from `models-store.json` for this provider. */
function storedProviderModels(context: RefreshModelsContext): Model<"openai-completions">[] {
	const baseUrl = resolveBaseUrl(loadConfig());
	const models: Model<"openai-completions">[] = [];
	for (const model of context.stored?.models ?? []) {
		if (model.provider !== PROVIDER_ID) continue;
		if (model.type !== undefined && model.type !== "chat") continue;
		// Keep them usable after a `baseUrl` change in a6api.json.
		models.push({ ...(model as Model<"openai-completions">), baseUrl });
	}
	return models;
}

/**
 * What to publish when the gateway cannot be reached: the newer of our snapshot
 * and pi's persisted catalog, so a failed refresh never empties the list the
 * way a bare `[]` would (pi persists whatever `fetchModels` returns).
 */
function fallbackModels(context: RefreshModelsContext): Model<"openai-completions">[] {
	const cached = providerModels();
	const stored = storedProviderModels(context);
	const age = snapshotAgeMs();
	const cachedAt = age === undefined ? 0 : Date.now() - age;
	const storedAt = context.stored?.checkedAt ?? 0;
	if (stored.length > 0 && storedAt > cachedAt) return stored;
	return cached.length > 0 ? cached : stored;
}

function buildProvider() {
	return createProvider({
		id: PROVIDER_ID,
		name: PROVIDER_NAME,
		baseUrl: resolveBaseUrl(loadConfig()),
		auth: { apiKey: envApiKeyAuth(`${PROVIDER_NAME} API key`, [...ENV_VARS]) },
		models: providerModels(),
		fetchModels: async (context) => {
			const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
			const age = snapshotAgeMs();
			const fresh = age !== undefined && age < catalogTtlMs();
			if (process.env.A6API_DEBUG) {
				console.error(
					`[a6api] fetchModels: allowNetwork=${context.allowNetwork} force=${context.force} cached=${getCatalog().length} stored=${context.stored?.models.length ?? 0} age=${age === undefined ? "none" : Math.round(age / 1000) + "s"} fresh=${fresh} key=${apiKey ? "yes" : "no"}`,
				);
			}

			// Launches pass force=true, so an hour-old snapshot is still replaced.
			if (!context.allowNetwork || !apiKey || (!context.force && fresh)) return fallbackModels(context);

			try {
				if (process.env.A6API_DEBUG) console.error("[a6api] fetchModels: fetching catalog");
				const payload = await fetchCatalogPayload(apiKey, context.signal);
				const parsed = parseCatalog(payload);
				const models = chatModels(parsed.models);
				if (process.env.A6API_DEBUG) {
					console.error(`[a6api] fetchModels: got ${models.length} chat models of ${parsed.models.length}`);
				}
				// An empty answer must not replace the persisted catalog.
				if (models.length === 0) return fallbackModels(context);
				setCatalog(parsed);
				writeSnapshotPayload(payload);
				return models.map((model) => toModel(model));
			} catch (error) {
				if (process.env.A6API_DEBUG) {
					console.error(
						`[a6api] fetchModels: error aborted=${context.signal.aborted} ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				if (!context.signal.aborted) {
					console.warn(
						`[a6api] catalog refresh failed, keeping the last known models: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				return fallbackModels(context);
			}
		},
		api: openAICompletionsApi(),
	});
}

// ─── Endpoint failover ───────────────────────────────────────────────

/** Stale ctx after a session switch or shutdown must not take pi down. */
function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	try {
		ctx.ui.notify(message, level);
	} catch {
		// The session is gone; the console line below is the only record left.
	}
	if (level !== "info") console.warn(`[a6api] ${message}`);
}

/**
 * Move the provider to another edge. The config-only `registerProvider(id, {
 * baseUrl })` shortcut is for config providers and drops a native registration,
 * so the provider is rebuilt with the URL the state file now resolves to; pi
 * then rewrites the live session model as well.
 *
 * The state file is the durable decision, so it is written first and the
 * re-registration stays best-effort: a switch can land after pi replaced the
 * extension runtime (`/reload`, session switch), and pi rejects every call on
 * the old object by killing the process.
 */
function activateEndpoint(
	url: string,
	primary: string,
	reason: string,
	ctx: ExtensionContext,
	options: { manual?: boolean } = {},
): boolean {
	if (url === primary) clearEndpointState();
	else writeEndpointState({ baseUrl: url, primary, since: Date.now(), reason, manual: options.manual === true });
	const pi = registeredPi;
	if (!pi) return false;
	try {
		pi.registerProvider(buildProvider());
	} catch (error) {
		console.warn(
			`[a6api] endpoint switch recorded, it will be applied on the next start: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
	renderStatus(ctx);
	return true;
}

/**
 * Rotate to the next edge that answers. Every switch is attempted by an actual
 * catalog refresh, so a host that resolves but serves nothing cannot win.
 */
async function failoverEndpoint(ctx: ExtensionContext, reason: string, generation: number): Promise<void> {
	if (!registeredPi || failoverInFlight || generation !== runtimeGeneration) return;
	const config = loadConfig();
	const primary = primaryBaseUrl(config);
	const current = resolveBaseUrl(config);
	const rotation = rotationFrom(endpointCandidates(primary, getGatewayEndpoints()), current);
	if (rotation.length === 0) {
		notify(ctx, "A6API: the gateway is unreachable and it publishes no other edge", "error");
		return;
	}
	failoverInFlight = true;
	try {
		for (const candidate of rotation) {
			if (generation !== runtimeGeneration) return;
			if (process.env.A6API_DEBUG) console.error(`[a6api] failover: trying ${candidate.url}`);
			const applied = activateEndpoint(candidate.url, primary, reason, ctx);
			if (await refreshCatalog(ctx, { attempts: 1 })) {
				const route = candidate.route ? ` (${candidate.route})` : "";
				notify(
					ctx,
					`A6API: ${endpointHost(current)} is unreachable, switched to ${endpointHost(candidate.url)}${route}`,
					"warning",
				);
				if (!applied) {
					notify(ctx, "A6API: restart pi to use the new edge (the runtime was replaced while switching)", "warning");
				}
				return;
			}
		}
		// Nothing answered: stay where we were instead of drifting further.
		activateEndpoint(current, primary, reason, ctx);
		notify(ctx, `A6API: no edge answered, still on ${endpointHost(current)}`, "error");
	} finally {
		failoverInFlight = false;
	}
}

/**
 * A switch from a previous session is remembered. Go back to the primary once
 * it answers again, otherwise keep using the edge that works.
 */
async function returnToPrimary(ctx: ExtensionContext): Promise<void> {
	const config = loadConfig();
	const primary = primaryBaseUrl(config);
	const state = readEndpointState();
	if (!state) return;
	if (state.primary !== primary || state.baseUrl === primary) {
		clearEndpointState();
		return;
	}
	// A manual pin is the user's choice: probing the primary must not undo it.
	if (state.manual) return;
	if (!(await probeEndpoint(primary))) {
		if (process.env.A6API_DEBUG) {
			console.error(`[a6api] primary ${endpointHost(primary)} still down, staying on ${endpointHost(state.baseUrl)}`);
		}
		return;
	}
	const route = endpointCandidates(primary, getGatewayEndpoints()).find((entry) => entry.url === primary)?.route;
	activateEndpoint(primary, primary, "primary recovered", ctx);
	notify(ctx, `A6API: ${endpointHost(primary)} is back${route ? ` (${route})` : ""}, using it again`, "info");
}

// ─── Catalog refresh ─────────────────────────────────────────────────

/** Refresh through pi's registry so the provider list and the snapshot agree. */
async function refreshCatalog(
	ctx: ExtensionContext,
	options: { attempts?: number; timeoutMs?: number } = {},
): Promise<boolean> {
	const attempts = options.attempts ?? CATALOG_REFRESH_ATTEMPTS;
	const timeoutMs = options.timeoutMs ?? CATALOG_REFRESH_TIMEOUT_MS;
	const debugLog = (message: string): void => {
		if (process.env.A6API_DEBUG) console.error(`[a6api] ${message}`);
	};
	let fetched = false;
	try {
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			if (!sessionActive) {
				debugLog("refreshCatalog: session ended, stopping");
				break;
			}
			if (attempt > 0) await delay(CATALOG_REFRESH_RETRY_MS * attempt);
			const before = snapshotWriteCount();
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const result = await ctx.modelRegistry.refresh({
					providers: [PROVIDER_ID],
					force: true,
					signal: controller.signal,
				});
				const error = result.errors.get(PROVIDER_ID);
				if (error) {
					console.warn(`[a6api] catalog refresh failed: ${error.message}`);
					break;
				}
			} catch (error) {
				console.warn(`[a6api] catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`);
				break;
			} finally {
				clearTimeout(timeout);
			}

			// Success means the refresh actually wrote a snapshot.
			const after = snapshotWriteCount();
			fetched = after !== before;
			if (fetched) {
				debugLog(`refreshCatalog: fetched catalog (attempt ${attempt + 1})`);
				break;
			}
			debugLog(`refreshCatalog: attempt ${attempt + 1} was superseded`);
		}
	} catch (error) {
		debugLog(`refreshCatalog: aborted (${error instanceof Error ? error.message : String(error)})`);
		return false;
	} finally {
		// The session may have shut down while the request was in flight.
		if (sessionActive) renderStatus(ctx);
	}
	return fetched;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Status ──────────────────────────────────────────────────────────

/**
 * Paint or clear the footer status. pi invalidates a ctx once its session is
 * replaced or shut down, so every access is guarded: a late refresh must not
 * take the process down.
 */
function renderStatus(ctx: ExtensionContext, options: { clear?: boolean } = {}): void {
	try {
		if (!ctx.hasUI) return;
		if (options.clear || ctx.model?.provider !== PROVIDER_ID) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const model = ctx.model;
		if (!model) return;
		const entry = getCatalogModel(model.id);
		const context = formatTokens(model.contextWindow);
		// A failover is invisible otherwise, and it changes where requests go.
		const config = loadConfig();
		const active = resolveBaseUrl(config);
		const edge = active === primaryBaseUrl(config) ? "" : ` · ${endpointHost(active)}`;
		if (!entry || entry.kind !== "chat") {
			ctx.ui.setStatus(STATUS_KEY, `A6 ${context}${edge}`);
			return;
		}
		const price =
			entry.cost.input === 0 && entry.cost.output === 0
				? "price unknown"
				: `${formatUsd(entry.cost.input)}/${formatUsd(entry.cost.output)}`;
		ctx.ui.setStatus(STATUS_KEY, `A6 ${price} ${context}${edge}`);
	} catch {
		// Stale ctx: the session is gone, so there is nothing left to paint.
	}
}

// ─── Command ─────────────────────────────────────────────────────────

function summaryLinesForCatalog(): string[] {
	const age = snapshotAgeMs();
	return summaryLines(getCatalog(), {
		baseUrl: resolveBaseUrl(loadConfig()),
		version: getPricingVersion(),
		groupRatio: getGroupRatio(),
		fetchedAt: age === undefined ? undefined : Date.now() - age,
	});
}

function formatAge(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** Edge list for `/a6api endpoint`: numbered, with the active and primary marked. */
function endpointLines(): string[] {
	const config = loadConfig();
	const primary = primaryBaseUrl(config);
	const current = resolveBaseUrl(config);
	const candidates = endpointCandidates(primary, getGatewayEndpoints());
	const state = readEndpointState();
	const width = Math.max(...candidates.map((candidate) => endpointHost(candidate.url).length));
	const lines = candidates.map((candidate, index) => {
		const marker = candidate.url === current ? "*" : " ";
		const host = endpointHost(candidate.url).padEnd(width);
		const detail = [candidate.route, candidate.note].filter(Boolean).join(" · ");
		const tags = [candidate.url === primary ? "primary" : "", candidate.url === current ? "active" : ""]
			.filter(Boolean)
			.join(", ");
		return `  ${marker} ${index + 1}  ${host}  ${detail}${tags ? `  [${tags}]` : ""}`;
	});
	const switched =
		state && state.baseUrl !== primary
			? state.manual
				? ` · pinned ${formatAge(Date.now() - state.since)} ago`
				: ` · switched ${formatAge(Date.now() - state.since)} ago${state.reason ? `: ${state.reason}` : ""}`
			: "";
	const head = `A6API endpoints${switched}`;
	const edges =
		getGatewayEndpoints().length > 0 ? "from api_info" : "defaults: the gateway has not published its edges yet";
	return [
		`${head} (${edges})`,
		"",
		...lines,
		"",
		"/a6api endpoint <number|url> pins an edge, /a6api endpoint reset goes back to the primary.",
	];
}

async function handleCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const trimmed = args.trim();
	const [subcommand = "", ...rest] = trimmed.split(/\s+/).filter(Boolean);

	/** Long reports get a scrollable overlay in the TUI and a notice elsewhere. */
	const report = (title: string, lines: string[]): void => {
		if (ctx.mode === "tui") {
			void ctx.ui.custom<void>((tui, theme, keybindings, done) => {
				return new TextViewComponent(tui, theme, keybindings, title, lines, () => done(undefined));
			});
			return;
		}
		ctx.ui.notify([title, ...lines].join("\n"), "info");
	};

	switch (subcommand) {
		case "": {
			if (ctx.mode !== "tui") {
				report("A6API models", [...summaryLinesForCatalog(), "", ...tableLines(getCatalog())]);
				return;
			}
			await ctx.waitForIdle?.();
			await ctx.ui.custom<CatalogModel | undefined>((tui, theme, keybindings, done) => {
				return new A6ApiPickerComponent(
					tui,
					theme,
					keybindings,
					{
						models: getCatalog(),
						currentId: ctx.model?.provider === PROVIDER_ID ? ctx.model.id : undefined,
						refresh: async () => {
							const fetched = await refreshCatalog(ctx);
							return {
								models: getCatalog(),
								warning: fetched ? undefined : "gateway did not answer: showing the cached catalog",
							};
						},
						select: async (entry) => {
							const model = ctx.modelRegistry.find(PROVIDER_ID, entry.id) ?? toModel(entry);
							return await pi.setModel(model);
						},
					},
					done,
				);
			});
			return;
		}

		case "refresh": {
			const fetched = await refreshCatalog(ctx);
			const chat = chatModels(getCatalog()).length;
			const edge = endpointHost(resolveBaseUrl(loadConfig()));
			if (fetched) {
				ctx.ui.notify(`A6API catalog refreshed via ${edge}: ${chat} chat models of ${getCatalog().length}.`, "info");
			} else {
				ctx.ui.notify(
					`Catalog not refreshed via ${edge} (no A6API key, offline, or superseded). Cached: ${chat} chat models.`,
					"warning",
				);
			}
			return;
		}

		case "endpoint": {
			const config = loadConfig();
			const primary = primaryBaseUrl(config);
			const target = rest.join(" ").trim();
			const candidates = endpointCandidates(primary, getGatewayEndpoints());

			if (target.length === 0) {
				report("A6API endpoints", endpointLines());
				return;
			}
			if (target.toLowerCase() === "reset") {
				activateEndpoint(primary, primary, "manual reset", ctx, { manual: true });
				const fetched = await refreshCatalog(ctx, { attempts: 1 });
				ctx.ui.notify(
					fetched
						? `A6API: back on the primary edge ${endpointHost(primary)}.`
						: `A6API: reset to ${endpointHost(primary)}, but the catalog did not refresh.`,
					fetched ? "info" : "warning",
				);
				return;
			}

			const index = Number.parseInt(target, 10);
			const picked =
				Number.isInteger(index) && index >= 1 && index <= candidates.length
					? candidates[index - 1]
					: candidates.find((candidate) => candidate.url === withV1(target));
			if (!picked) {
				report(`A6API · no edge "${target}"`, endpointLines());
				return;
			}
			activateEndpoint(picked.url, primary, "manual switch", ctx, { manual: true });
			const fetched = await refreshCatalog(ctx, { attempts: 1 });
			ctx.ui.notify(
				fetched
					? `A6API: using ${endpointHost(picked.url)}.`
					: `A6API: ${endpointHost(picked.url)} did not answer, the model list is unchanged.`,
				fetched ? "info" : "warning",
			);
			return;
		}

		case "list": {
			const filter = rest.join(" ");
			report(`A6API models · ${filter || "all"}`, [...summaryLinesForCatalog(), "", ...tableLines(getCatalog(), filter)]);
			return;
		}

		default: {
			const entry = getCatalogModel(trimmed);
			if (!entry) {
				const closest = tableLines(getCatalog(), trimmed).slice(1, 11);
				report(`A6API · no model "${trimmed}"`, ["Closest entries:", ...closest.map((line) => `  ${line}`)]);
				return;
			}
			report(`A6API · ${entry.id}`, describeLines(entry));
		}
	}
}
