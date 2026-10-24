/**
 * pi-a6api-provider — A6API provider support and model catalog browser.
 *
 * Provider: registers `a6api` (OpenAI-compatible gateway at
 * https://a6api.com/v1) with a catalog discovered from the gateway, so the
 * models appear in `/model`, `Ctrl+P` and `/models` like a built-in provider,
 * priced in the footer and in `/session`.
 *
 * Data flow follows pi-anymodel-provider: one `fetchCatalogPayload()` per refresh, one
 * raw snapshot on disk, `loadCatalogFromDisk()` before the provider registers,
 * and a TTL check so a session does not re-fetch a fresh catalog.
 *
 * Info: `/a6api` opens a searchable model browser (price, cache price,
 * long-context tiers, context/output limits, vendor, gateway groups), plus
 * `/a6api list`, `/a6api <model>`, and `/a6api refresh`.
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
	getGroupRatio,
	getPricingVersion,
	loadCatalogFromDisk,
	parseCatalog,
	setCatalog,
	snapshotAgeMs,
	snapshotPath,
	toModel,
	writeSnapshotPayload,
	type CatalogModel,
} from "./catalog.ts";
import { loadConfig, resolveBaseUrl } from "./config.ts";
import { describeLines, formatTokens, formatUsd, summaryLines, tableLines } from "./info.ts";
import { A6ApiPickerComponent } from "./picker.ts";
import { TextViewComponent } from "./text-view.ts";

const STATUS_KEY = "pi-a6api";
const CATALOG_REFRESH_TIMEOUT_MS = 8_000;
const CATALOG_REFRESH_ATTEMPTS = 3;
const CATALOG_REFRESH_RETRY_MS = 600;

/** A refresh can outlive its session (print mode exits fast); stale ctx must not throw. */
let sessionActive = false;

export default function a6apiExtension(pi: ExtensionAPI): void {
	const debug = (message: string): void => {
		if (process.env.A6API_DEBUG) console.error(`[a6api] ${message}`);
	};

	/** Startup catalog refresh runs once per extension instance (i.e. per pi launch). */
	let startupRefreshDone = false;

	const loaded = loadCatalogFromDisk();
	pi.registerProvider(buildProvider());
	debug(`provider registered with ${loaded} models from ${snapshotPath()}`);

	pi.on("session_start", async (_event, ctx) => {
		sessionActive = true;
		// Another process may have refreshed the snapshot since load.
		loadCatalogFromDisk();
		renderStatus(ctx);
		if (!startupRefreshDone) {
			startupRefreshDone = true;
			void refreshCatalog(ctx);
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		renderStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionActive = false;
		renderStatus(ctx, { clear: true });
	});

	pi.registerCommand("a6api", {
		description: "A6API: browse models, prices, and limits",
		getArgumentCompletions: (prefix) => {
			const commands = [
				{ value: "list", label: "list [filter]", description: "Print the model table" },
				{ value: "refresh", label: "refresh", description: "Reload /v1/models and /api/pricing" },
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

// ─── Catalog refresh ─────────────────────────────────────────────────

/** Refresh through pi's registry so the provider list and the snapshot agree. */
async function refreshCatalog(ctx: ExtensionContext): Promise<boolean> {
	const debugLog = (message: string): void => {
		if (process.env.A6API_DEBUG) console.error(`[a6api] ${message}`);
	};
	let fetched = false;
	try {
		for (let attempt = 0; attempt < CATALOG_REFRESH_ATTEMPTS; attempt += 1) {
			if (!sessionActive) {
				debugLog("refreshCatalog: session ended, stopping");
				break;
			}
			if (attempt > 0) await delay(CATALOG_REFRESH_RETRY_MS * attempt);
			const before = snapshotAgeMs();
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), CATALOG_REFRESH_TIMEOUT_MS);
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

			// Success means a snapshot exists now and is newer than before the attempt.
			const after = snapshotAgeMs();
			fetched = after !== undefined && (before === undefined || after < before);
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
		if (!entry || entry.kind !== "chat") {
			ctx.ui.setStatus(STATUS_KEY, `A6 ${context}`);
			return;
		}
		const price =
			entry.cost.input === 0 && entry.cost.output === 0
				? "price unknown"
				: `${formatUsd(entry.cost.input)}/${formatUsd(entry.cost.output)}`;
		ctx.ui.setStatus(STATUS_KEY, `A6 ${price} ${context}`);
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
			if (fetched) {
				ctx.ui.notify(`A6API catalog refreshed: ${chat} chat models of ${getCatalog().length}.`, "info");
			} else {
				ctx.ui.notify(
					`Catalog not refreshed (no A6API key, offline, or superseded). Cached: ${chat} chat models.`,
					"warning",
				);
			}
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
