/**
 * A6API catalog: one provider payload, parsed into pi model definitions, with a
 * local snapshot for offline startup.
 *
 * The shape follows pi-anymodel-provider: a single `fetchCatalogPayload()` returns the
 * raw payload, `writeSnapshotPayload()` stores it verbatim, `parseCatalog()`
 * turns it into models, and `loadCatalogFromDisk()` restores it before the
 * provider is registered.
 *
 * The difference is what the gateway publishes. AnyModel returns models,
 * pricing, and limits in one `GET /v1/models`; A6API splits them across
 * `GET /v1/models` (which models this key may call, needs the key) and the
 * public `GET /api/pricing` (prices, groups, endpoints, vendors). Both are
 * fetched together, stored in one payload `{ models, pricing }`, and joined
 * here, so a model listed only by one side still appears with the other half
 * marked as unknown.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BASE_URL, type A6ApiConfig, loadConfig, resolveBaseUrl } from "./config.ts";
import { estimateLimits, looksReasoning, looksVision, vendorCatalogLimits, type ResolvedLimits } from "./estimate.ts";
import { asArray, asNumber, asRecord, asString, stringList } from "./json.ts";
import {
	type PricingCatalog,
	type PricingCost,
	type PricingEntry,
	type QuotaKind,
	emptyPricing,
	parsePricing,
	zeroCost,
} from "./pricing.ts";

export const PROVIDER_ID = "a6api";
export const PROVIDER_NAME = "A6API";
export const ENV_VARS = ["A6API_API_KEY", "A6API_KEY"] as const;

const API = "openai-completions" as const;
const FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const SNAPSHOT_VERSION = 1;

/** Raw provider payload: both gateway answers, stored before parsing. */
export interface CatalogPayload {
	models: unknown;
	pricing: unknown;
}

/** What the gateway's endpoints say a model is for. */
export type ModelKind = "chat" | "image" | "video" | "embedding";

/** Where the context window came from; shown in the info command. */
export type LimitsSource = "config" | "catalog" | "pricing" | "estimate";

/** Resolves limits from pi's built-in catalog for the model's vendor. */
export type LimitsResolver = (id: string) => ResolvedLimits | undefined;

export interface CatalogModel {
	id: string;
	name: string;
	kind: ModelKind;
	/** Gateway endpoint types, e.g. `openai`, `image-generation`, `openai-video`. */
	endpoints: string[];
	/** Pricing block, or undefined when the gateway published no price for the id. */
	pricing?: PricingEntry;
	vendor?: string;
	reasoning: boolean;
	vision: boolean;
	contextWindow: number;
	maxTokens: number;
	limits: LimitsSource;
	/** Context-window origin, with the pi catalog provider when it came from one. */
	limitsFrom?: string;
	cost: PricingCost;
	compat?: OpenAICompletionsCompat;
	hidden: boolean;
}

/** The joined catalog plus the gateway metadata the info command reports. */
export interface Catalog {
	models: CatalogModel[];
	/** Pricing hash published by the gateway; changes when prices change. */
	version?: string;
	/** Multiplier the gateway applies to every ratio for the default group. */
	groupRatio: number;
}

/** Overrides used by the tests; production reads the config file and pi's catalog. */
export interface ParseOptions {
	config?: A6ApiConfig;
	resolveLimits?: LimitsResolver;
}

// ─── Naming ──────────────────────────────────────────────────────────

/** Tokens that stay upper-case in a display name. */
const ACRONYMS = new Map([
	["gpt", "GPT"],
	["glm", "GLM"],
	["ai", "AI"],
	["api", "API"],
	["vl", "VL"],
	["moe", "MoE"],
	["oss", "OSS"],
	["deepseek", "DeepSeek"],
	["minimax", "MiniMax"],
	["mimo", "MiMo"],
	["longcat", "LongCat"],
]);

/**
 * Readable display name for a gateway id: `claude-sonnet-5-5` becomes
 * "Claude Sonnet 5.5". Consecutive numeric segments join with a dot, which is
 * how the upstream vendors write versions.
 */
export function prettyName(id: string): string {
	const parts = id.split(/[-_/]+/).filter((part) => part.length > 0);
	const words: string[] = [];
	for (const part of parts) {
		const lower = part.toLowerCase();
		const acronym = ACRONYMS.get(lower);
		if (acronym) {
			words.push(acronym);
			continue;
		}
		const previous = words[words.length - 1];
		const numeric = /^v?\d+(?:\.\d+)*$/.test(part);
		// "5" after "5" is a version pair, not a second word; dates stay separate.
		if (numeric && previous !== undefined && /^\d/.test(previous) && part.length <= 2) {
			words[words.length - 1] = `${previous}.${part}`;
			continue;
		}
		if (numeric && /^v/.test(lower)) {
			words.push(lower.toUpperCase());
			continue;
		}
		words.push(part.charAt(0).toUpperCase() + part.slice(1));
	}
	return words.join(" ");
}

// ─── Parsing ─────────────────────────────────────────────────────────

/** Per-call models are image/video generators: they cannot answer a chat request. */
function classifyKind(id: string, endpoints: readonly string[], quota: QuotaKind | undefined): ModelKind {
	if (/embedding/i.test(id)) return "embedding";
	if (endpoints.includes("openai-video")) return "video";
	if (endpoints.includes("image-generation")) return "image";
	if (quota === "calls") return "image";
	return "chat";
}

interface LiveModel {
	id: string;
	endpoints: string[];
}

function parseLiveModels(payload: unknown): LiveModel[] {
	const models: LiveModel[] = [];
	const seen = new Set<string>();
	for (const raw of asArray(asRecord(payload)?.data)) {
		const entry = asRecord(raw);
		const id = asString(entry?.id);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		models.push({ id, endpoints: stringList(entry?.supported_endpoint_types) });
	}
	return models;
}

function applyCostOverride(base: PricingCost, override: NonNullable<A6ApiConfig["models"][string]["cost"]>): PricingCost {
	// An overridden base price invalidates the tiers derived from the ratios.
	return {
		input: override.input ?? base.input,
		output: override.output ?? base.output,
		cacheRead: override.cacheRead ?? base.cacheRead,
		cacheWrite: override.cacheWrite ?? base.cacheWrite,
		tiers: [],
	};
}

function buildModel(
	live: LiveModel,
	pricing: PricingCatalog,
	config: A6ApiConfig,
	resolveLimits: LimitsResolver,
): CatalogModel {
	const override = config.models[live.id] ?? {};
	const price = pricing.entries.get(live.id);
	const endpoints = live.endpoints.length > 0 ? live.endpoints : (price?.endpoints ?? []);
	const kind = classifyKind(live.id, endpoints, price?.quota);

	// pi's vendor catalog knows the upstream model; the family table is the fallback.
	const resolved = resolveLimits(live.id);
	const fallback = resolved?.limits ?? estimateLimits(live.id);
	const threshold = price?.cost.tiers[0]?.inputTokensAbove;
	let contextWindow = fallback.contextWindow;
	let limits: LimitsSource = resolved?.exact ? "catalog" : "estimate";
	let limitsFrom = resolved?.source;

	// The gateway bills long requests separately, which proves the model accepts them.
	if (threshold !== undefined && threshold > contextWindow) {
		contextWindow = threshold;
		limits = "pricing";
		limitsFrom = undefined;
	}
	if (override.contextWindow !== undefined) {
		contextWindow = override.contextWindow;
		limits = "config";
		limitsFrom = undefined;
	}
	// Output caps never exceed the window, and the config wins over the catalog.
	const maxTokens = Math.min(override.maxTokens ?? fallback.maxTokens, contextWindow);

	const cost = price ? price.cost : zeroCost();

	return {
		id: live.id,
		name: override.name ?? prettyName(live.id),
		kind,
		endpoints,
		pricing: price,
		vendor: price?.vendor,
		reasoning: override.reasoning ?? looksReasoning(live.id),
		vision: override.vision ?? looksVision(live.id),
		contextWindow,
		maxTokens,
		limits,
		limitsFrom,
		cost: override.cost ? applyCostOverride(cost, override.cost) : cost,
		compat: override.compat,
		hidden: override.hidden === true || config.hidden.includes(live.id),
	};
}

/** Join the raw provider payload into the model catalog. */
export function parseCatalog(payload: unknown, options: ParseOptions = {}): Catalog {
	const config = options.config ?? loadConfig();
	const resolveLimits = options.resolveLimits ?? vendorCatalogLimits;
	const root = asRecord(payload);
	if (!root) return { models: [], groupRatio: 1 };

	const pricing = parsePricing(root.pricing);
	const models: CatalogModel[] = [];
	const seen = new Set<string>();

	for (const live of parseLiveModels(root.models)) {
		seen.add(live.id);
		models.push(buildModel(live, pricing, config, resolveLimits));
	}
	// Pricing may list models the key cannot call; keep them so the info command
	// still shows what the platform offers.
	for (const id of pricing.entries.keys()) {
		if (seen.has(id)) continue;
		models.push(buildModel({ id, endpoints: [] }, pricing, config, resolveLimits));
	}
	return { models, version: pricing.version, groupRatio: pricing.groupRatio };
}

/** Chat models that pi should expose for this provider. */
export function chatModels(catalog: readonly CatalogModel[]): CatalogModel[] {
	return catalog.filter((model) => model.kind === "chat" && !model.hidden);
}

/** Convert a catalog entry into a pi model definition. */
export function toModel(entry: CatalogModel, baseUrl = resolveBaseUrl(loadConfig())): Model<"openai-completions"> {
	const compat: OpenAICompletionsCompat = {
		// The gateway fans out to non-OpenAI upstreams, which reject
		// `max_completion_tokens`; `max_tokens` is the common denominator.
		maxTokensField: "max_tokens",
		// Reasoning effort is not a gateway-level capability: sending it breaks the
		// upstreams that do not know the field. Thinking content still streams in
		// `reasoning_content`, and the config can opt a model in.
		supportsReasoningEffort: false,
		...entry.compat,
	};

	return {
		id: entry.id,
		name: entry.name,
		api: API,
		provider: PROVIDER_ID,
		baseUrl,
		reasoning: entry.reasoning,
		input: entry.vision ? ["text", "image"] : ["text"],
		cost: {
			input: entry.cost.input,
			output: entry.cost.output,
			cacheRead: entry.cost.cacheRead,
			cacheWrite: entry.cost.cacheWrite,
			...(entry.cost.tiers.length > 0 ? { tiers: entry.cost.tiers } : {}),
		},
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		compat,
	};
}

// ─── In-memory catalog ───────────────────────────────────────────────

let catalog: CatalogModel[] = [];
const catalogById = new Map<string, CatalogModel>();
let snapshotFetchedAt: number | undefined;
let pricingVersion: string | undefined;
let groupRatio = 1;

export function setCatalog(next: Catalog, fetchedAt?: number): void {
	catalog = [...next.models];
	catalogById.clear();
	for (const model of catalog) catalogById.set(model.id, model);
	pricingVersion = next.version;
	groupRatio = next.groupRatio;
	if (fetchedAt !== undefined) snapshotFetchedAt = fetchedAt;
}

export function getCatalog(): readonly CatalogModel[] {
	return catalog;
}

export function getCatalogModel(id: string): CatalogModel | undefined {
	return catalogById.get(id);
}

/** Pricing hash of the loaded catalog, for the info command. */
export function getPricingVersion(): string | undefined {
	return pricingVersion;
}

/** Default-group multiplier of the loaded catalog. */
export function getGroupRatio(): number {
	return groupRatio;
}

export function snapshotAgeMs(now = Date.now()): number | undefined {
	return snapshotFetchedAt === undefined ? undefined : Math.max(0, now - snapshotFetchedAt);
}

/** How long a snapshot is considered fresh. `A6API_CATALOG_TTL_MS=0` refreshes every time. */
export function catalogTtlMs(): number {
	const raw = process.env.A6API_CATALOG_TTL_MS;
	if (raw !== undefined) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return DEFAULT_TTL_MS;
}

// ─── Local snapshot ──────────────────────────────────────────────────

export function snapshotPath(): string {
	return join(getAgentDir(), `${PROVIDER_ID}-catalog.json`);
}

/** Read the stored raw payload and record its fetch time. */
export function readSnapshotPayload(): unknown | undefined {
	try {
		const root = asRecord(JSON.parse(readFileSync(snapshotPath(), "utf8")) as unknown);
		if (!root || root.version !== SNAPSHOT_VERSION || !root.payload) return undefined;
		snapshotFetchedAt = asNumber(root.fetchedAt);
		return root.payload;
	} catch {
		return undefined;
	}
}

export function writeSnapshotPayload(payload: CatalogPayload): void {
	const fetchedAt = Date.now();
	try {
		const file = snapshotPath();
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({ version: SNAPSHOT_VERSION, provider: PROVIDER_ID, fetchedAt, payload }),
			"utf8",
		);
		snapshotFetchedAt = fetchedAt;
	} catch (error) {
		console.warn(`[a6api] could not write catalog snapshot: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Load the snapshot into memory. Returns the number of catalog models loaded. */
export function loadCatalogFromDisk(options: ParseOptions = {}): number {
	const payload = readSnapshotPayload();
	if (!payload) return 0;
	const parsed = parseCatalog(payload, options);
	setCatalog(parsed, snapshotFetchedAt);
	return parsed.models.length;
}

// ─── Network ─────────────────────────────────────────────────────────

/** Public pricing endpoint for the gateway that serves `baseUrl`. */
export function pricingUrl(baseUrl = resolveBaseUrl(loadConfig())): string {
	const override = process.env.A6API_PRICING_URL;
	if (override && override.trim().length > 0) return override;
	try {
		return new URL("/api/pricing", baseUrl).toString();
	} catch {
		return new URL("/api/pricing", DEFAULT_BASE_URL).toString();
	}
}

function combinedSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function getJson(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(
			`GET ${new URL(url).pathname} → HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
		);
	}
	return (await response.json()) as unknown;
}

/**
 * Fetch the raw catalog payload: the token's model list plus the public pricing
 * table. One call, one payload, stored verbatim, exactly like AnyModel's
 * `GET /v1/models` snapshot.
 */
export async function fetchCatalogPayload(apiKey: string, signal?: AbortSignal): Promise<CatalogPayload> {
	const baseUrl = resolveBaseUrl(loadConfig());
	const modelsUrl = `${baseUrl.replace(/\/$/, "")}/models`;
	const [models, pricing] = await Promise.all([
		getJson(modelsUrl, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal: combinedSignal(signal),
		}),
		// The pricing endpoint is public: no key is sent, so a broken key cannot
		// hide the model list.
		getJson(pricingUrl(baseUrl), {
			headers: { Accept: "application/json" },
			signal: combinedSignal(signal),
		}),
	]);
	return { models, pricing };
}
