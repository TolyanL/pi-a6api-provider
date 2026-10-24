/**
 * Context windows, output limits, reasoning, and vision hints for gateway models.
 *
 * The gateway publishes no limits at all: `GET /v1/models` lists ids, and the
 * pricing payload has ratios only. pi needs a context window and an output
 * limit per chat model, so the extension resolves them in this order:
 *
 *   1. `~/.pi/agent/a6api.json` entry for the model (handled by the catalog),
 *   2. pi's own built-in catalog for the model's *vendor* — the same data pi
 *      uses for native providers, e.g. `anthropic/claude-sonnet-5`,
 *   3. the closest sibling in that vendor catalog (`gpt-5.6` → `gpt-5.6-sol`),
 *   4. the family table below,
 *   5. a conservative default.
 *
 * Only the vendor that owns the model id is consulted: aggregator catalogs
 * (opencode, github-copilot, …) list foreign models with their own limits,
 * which are not a safe source for what the gateway routes to.
 */

import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

export interface Limits {
	contextWindow: number;
	maxTokens: number;
}

/** Where a resolved limit came from, so the info command can label it. */
export interface ResolvedLimits {
	limits: Limits;
	/** True when the vendor catalog lists this exact model id. */
	exact: boolean;
	/** pi catalog provider the limits came from, e.g. `anthropic`. */
	source?: string;
}

/** Model-id families and the pi catalog providers that own them. */
const VENDOR_PROVIDERS: { pattern: RegExp; providers: string[] }[] = [
	{ pattern: /^claude/, providers: ["anthropic"] },
	{ pattern: /^(gpt|o\d|codex)/, providers: ["openai", "azure", "openai-codex"] },
	{ pattern: /^gemini/, providers: ["google", "google-vertex"] },
	{ pattern: /^deepseek/, providers: ["deepseek"] },
	{ pattern: /^(kimi|moonshot)/, providers: ["moonshotai", "moonshotai-cn", "kimi-coding"] },
	{ pattern: /^glm/, providers: ["zai", "zai-coding-cn"] },
	{ pattern: /^qwen/, providers: ["qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual"] },
	{ pattern: /^minimax/, providers: ["minimax", "minimax-cn"] },
	{ pattern: /^grok/, providers: ["xai"] },
	{
		pattern: /^mimo/,
		providers: ["xiaomi", "xiaomi-token-plan", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"],
	},
	{ pattern: /^(muse|llama)/, providers: ["meta"] },
];

/** Vendor suffixes that do not change the underlying model. */
const VARIANT_SUFFIXES = [
	"preview",
	"latest",
	"exp",
	"experimental",
	"reasoning",
	"non-reasoning",
	"build-fast",
	"chat-latest",
	"vision-exp",
	"extra-low",
	"high",
	"medium",
	"low",
	"chat",
];

function normalize(id: string): string {
	return id
		.toLowerCase()
		.replace(/[._]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[a-z]{1,3}\//, "");
}

/** Drop date stamps and variant suffixes: `deepseek-v4.1-flash-1017` → `deepseek-v4-1-flash`. */
function trimmed(id: string): string {
	let key = normalize(id);
	for (;;) {
		const before = key;
		key = key.replace(/-\d{4}$/, "");
		const suffix = VARIANT_SUFFIXES.find((value) => key.endsWith(`-${value}`));
		if (suffix) key = key.slice(0, -(suffix.length + 1));
		if (key === before) return key;
	}
}

function segments(id: string): string[] {
	return normalize(id).split("-").filter((part) => part.length > 0);
}

/** Longest shared leading run of segments; the vendor name alone does not count. */
function sharedPrefix(a: string[], b: string[]): number {
	let index = 0;
	while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
	return index;
}

interface VendorCatalog {
	provider: string;
	byId: Map<string, Limits>;
}

let vendorCatalogs: VendorCatalog[] | undefined;

/** Lazily index pi's built-in catalog by provider; ~1k models, built once per process. */
function catalogs(): VendorCatalog[] {
	if (vendorCatalogs) return vendorCatalogs;
	const built: VendorCatalog[] = [];
	try {
		for (const provider of getBuiltinProviders()) {
			const byId = new Map<string, Limits>();
			for (const model of getBuiltinModels(provider)) {
				byId.set(normalize(model.id), {
					contextWindow: model.contextWindow,
					maxTokens: Math.min(model.maxTokens ?? model.contextWindow, model.contextWindow),
				});
			}
			built.push({ provider, byId });
		}
	} catch {
		// A broken or partial catalog must not break model registration.
		vendorCatalogs = [];
		return vendorCatalogs;
	}
	vendorCatalogs = built;
	return vendorCatalogs;
}

function providersFor(id: string): string[] | undefined {
	const lower = id.toLowerCase();
	const family = VENDOR_PROVIDERS.find((entry) => entry.pattern.test(lower));
	return family?.providers;
}

/**
 * Limits from pi's built-in catalog for the vendor that owns `id`.
 * Exact ids win; otherwise the closest sibling in the same vendor catalog.
 */
export function vendorCatalogLimits(id: string): ResolvedLimits | undefined {
	const providers = providersFor(id);
	if (!providers) return undefined;
	const key = normalize(id);
	const looseKey = trimmed(id);
	const idSegments = segments(id);

	// Exact and suffix-trimmed matches first: the same model, whatever its alias.
	for (const provider of providers) {
		const catalog = catalogs().find((entry) => entry.provider === provider);
		if (!catalog) continue;
		const exact = catalog.byId.get(key);
		if (exact) return { limits: { ...exact }, exact: true, source: provider };
		const loose = catalog.byId.get(looseKey);
		if (loose) return { limits: { ...loose }, exact: false, source: provider };
	}

	// No alias: take the sibling sharing the longest run of id segments, e.g.
	// `gpt-5.6` → `gpt-5.6-sol`, `claude-mythos-5` → the Claude 5 generation.
	// Closest sibling wins: longest shared prefix, then the shortest catalog id
	// (the more specific model), then the earlier provider in the vendor list.
	let best: { limits: Limits; source: string; shared: number; length: number } | undefined;
	for (const provider of providers) {
		const catalog = catalogs().find((entry) => entry.provider === provider);
		if (!catalog) continue;
		for (const [catalogId, limits] of catalog.byId) {
			const shared = sharedPrefix(idSegments, segments(catalogId));
			// One segment is just the vendor or family name: too weak to extrapolate.
			if (shared < 2) continue;
			const length = catalogId.length;
			if (!best || shared > best.shared || (shared === best.shared && length < best.length)) {
				best = { limits: { ...limits }, source: provider, shared, length };
			}
		}
	}
	return best ? { limits: best.limits, exact: false, source: best.source } : undefined;
}

const FAMILIES: { pattern: RegExp; limits: Limits }[] = [
	{ pattern: /^claude-/, limits: { contextWindow: 200_000, maxTokens: 64_000 } },
	{ pattern: /^gemini-/, limits: { contextWindow: 1_048_576, maxTokens: 65_536 } },
	{ pattern: /^gpt-[56](?:[.-]|$)/, limits: { contextWindow: 400_000, maxTokens: 128_000 } },
	{ pattern: /^gpt-4\.1/, limits: { contextWindow: 1_047_576, maxTokens: 32_768 } },
	{ pattern: /^gpt-4o/, limits: { contextWindow: 128_000, maxTokens: 16_384 } },
	{ pattern: /^deepseek-v4/i, limits: { contextWindow: 200_000, maxTokens: 65_536 } },
	{ pattern: /^deepseek-/, limits: { contextWindow: 131_072, maxTokens: 32_768 } },
	{ pattern: /^grok-/, limits: { contextWindow: 256_000, maxTokens: 32_768 } },
	{ pattern: /^kimi-/, limits: { contextWindow: 256_000, maxTokens: 32_768 } },
	{ pattern: /^moonshot/, limits: { contextWindow: 262_144, maxTokens: 32_768 } },
	{ pattern: /^qwen/, limits: { contextWindow: 262_144, maxTokens: 32_768 } },
	{ pattern: /^glm-/, limits: { contextWindow: 200_000, maxTokens: 128_000 } },
	{ pattern: /^minimax-/, limits: { contextWindow: 204_800, maxTokens: 32_768 } },
	{ pattern: /^mimo-/, limits: { contextWindow: 262_144, maxTokens: 32_768 } },
	{ pattern: /^muse-/, limits: { contextWindow: 262_144, maxTokens: 32_768 } },
	{ pattern: /^longcat/i, limits: { contextWindow: 131_072, maxTokens: 32_768 } },
	{ pattern: /^step-/, limits: { contextWindow: 131_072, maxTokens: 32_768 } },
	{ pattern: /^hy\d/i, limits: { contextWindow: 131_072, maxTokens: 32_768 } },
];

/** Used when neither the catalog nor a family matches: safe for any upstream. */
export const DEFAULT_LIMITS: Limits = { contextWindow: 131_072, maxTokens: 32_768 };

/** Family-table estimate for a model id: the first matching family wins. */
export function estimateLimits(id: string): Limits {
	for (const family of FAMILIES) {
		if (family.pattern.test(id)) return { ...family.limits };
	}
	return { ...DEFAULT_LIMITS };
}

/** Families the gateway proxies for models that cannot think: everything else can. */
const NON_REASONING = [
	/^gpt-4o/,
	/^gpt-4-turbo/,
	/-non-reasoning$/,
	/-chat-latest$/,
	/embedding/i,
	/^codex-auto-review$/,
];

/** Whether a model is expected to emit reasoning while answering. */
export function looksReasoning(id: string): boolean {
	return !NON_REASONING.some((pattern) => pattern.test(id));
}

/** Families that accept image input through the gateway's OpenAI endpoint. */
const VISION = [
	/^claude-/,
	/^gemini-/,
	/^gpt-[456]/,
	/^gpt-4o/,
	/^grok-/,
	/-vision/i,
	/omni/i,
	/^qwen.*-vl/i,
	/^mimo-v/i,
];

export function looksVision(id: string): boolean {
	return VISION.some((pattern) => pattern.test(id));
}
