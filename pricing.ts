/**
 * A6API pricing from the public `GET /api/pricing` endpoint.
 *
 * The gateway (a new-api fork) publishes *ratios*, not money. Both its model
 * page and its billing code convert them the same way — verified in the site
 * bundle: `usd per 1M tokens = ratio * 2 * group_ratio`. So `model_ratio` 0.5 is
 * $1/M input tokens, `completion_ratio` scales the output price, and
 * `cache_ratio` / `create_cache_ratio` scale the cache prices.
 *
 * `long_context_pricing` holds *multipliers* that apply once the request grows
 * past `threshold`; pi can express them as cost tiers.
 *
 * Per-call models (`quota_type: 1`: images, video) price `model_price` in USD
 * per request instead of per token. They are never registered as chat models;
 * the extension only reports their price.
 */

import { asArray, asNumber, asRecord, asString, positiveInt, stringList } from "./json.ts";

/** USD per million tokens for a model ratio of 1. */
export const RATIO_USD_PER_MILLION = 2;

export interface PricingTier {
	inputTokensAbove: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface PricingCost {
	/** USD per million tokens. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Tiers for long requests, cheapest first. */
	tiers: PricingTier[];
}

/** Billing unit the gateway charges for one model. */
export type QuotaKind = "tokens" | "calls";

export interface PricingEntry {
	id: string;
	quota: QuotaKind;
	/** USD per request, only for `calls` models. */
	perCallUsd?: number;
	cost: PricingCost;
	/** Gateway groups that may serve the model, e.g. `default` and `supplier-*`. */
	groups: string[];
	/** Endpoint types the gateway exposes for the model, e.g. `openai`, `image-generation`. */
	endpoints: string[];
	vendor?: string;
	/** Per-spec multipliers for video models, kept for display. */
	videoSpecs?: Record<string, number>;
}

export interface PricingCatalog {
	/** Cache-busting hash published by the gateway; changes when prices change. */
	version?: string;
	/** Multiplier for the `default` group, applied to every ratio. */
	groupRatio: number;
	entries: Map<string, PricingEntry>;
}

export function emptyPricing(): PricingCatalog {
	return { groupRatio: 1, entries: new Map() };
}

/** All-zero cost: a model whose price the gateway did not publish. */
export function zeroCost(): PricingCost {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [] };
}

function parseMultipliers(raw: unknown): Record<string, number> {
	const record = asRecord(raw);
	const multipliers: Record<string, number> = {};
	if (!record) return multipliers;
	for (const [key, value] of Object.entries(record)) {
		const parsed = asNumber(value);
		if (parsed !== undefined) multipliers[key] = parsed;
	}
	return multipliers;
}

function parseTiers(raw: unknown, base: Omit<PricingCost, "tiers">): PricingTier[] {
	const spec = asRecord(raw);
	const threshold = positiveInt(spec?.threshold);
	if (!spec || threshold === undefined) return [];
	// Ratio fields are multipliers on the base price; missing fields keep the base.
	const scale = (field: string, fallback: number): number => asNumber(spec[field]) ?? fallback;
	return [
		{
			inputTokensAbove: threshold,
			input: base.input * scale("input", 1),
			output: base.output * scale("output", 1),
			cacheRead: base.cacheRead * scale("cache_read", 1),
			cacheWrite: base.cacheWrite * scale("cache_write", 1),
		},
	];
}

function parseEntry(raw: unknown, groupRatio: number, vendors: Map<number, string>): PricingEntry | undefined {
	const entry = asRecord(raw);
	const id = asString(entry?.model_name);
	if (!entry || !id) return undefined;

	const quota: QuotaKind = asNumber(entry.quota_type) === 1 ? "calls" : "tokens";

	const ratio = asNumber(entry.model_ratio) ?? 0;
	const completionRatio = asNumber(entry.completion_ratio) ?? 1;
	const input = ratio * groupRatio * RATIO_USD_PER_MILLION;
	// A missing cache ratio means the gateway has no cache discount: keep the input price.
	const cacheReadRatio = asNumber(entry.cache_ratio) ?? 1;
	const cacheWriteRatio = asNumber(entry.create_cache_ratio) ?? cacheReadRatio;
	const rates = {
		input,
		output: input * completionRatio,
		cacheRead: input * cacheReadRatio,
		cacheWrite: input * cacheWriteRatio,
	};

	const vendorId = asNumber(entry.vendor_id);
	const videoSpecs = parseMultipliers(entry.video_spec_prices);

	return {
		id,
		quota,
		perCallUsd: quota === "calls" ? asNumber(entry.model_price) : undefined,
		cost: { ...rates, tiers: parseTiers(entry.long_context_pricing, rates) },
		groups: stringList(entry.enable_groups),
		endpoints: stringList(entry.supported_endpoint_types),
		vendor: vendorId === undefined ? undefined : vendors.get(vendorId),
		videoSpecs: Object.keys(videoSpecs).length > 0 ? videoSpecs : undefined,
	};
}

function parseVendors(payload: Record<string, unknown>): Map<number, string> {
	const vendors = new Map<number, string>();
	for (const raw of asArray(payload.vendors)) {
		const vendor = asRecord(raw);
		const id = asNumber(vendor?.id);
		const name = asString(vendor?.name);
		if (id !== undefined && name) vendors.set(id, name);
	}
	return vendors;
}

/** Parse the `GET /api/pricing` payload. Malformed data yields an empty catalog. */
export function parsePricing(payload: unknown): PricingCatalog {
	const root = asRecord(payload);
	if (!root) return emptyPricing();

	const groupRatio = asNumber(asRecord(root.group_ratio)?.default) ?? 1;
	const vendors = parseVendors(root);
	const entries = new Map<string, PricingEntry>();
	for (const raw of asArray(root.data)) {
		const entry = parseEntry(raw, groupRatio, vendors);
		if (entry && !entries.has(entry.id)) entries.set(entry.id, entry);
	}

	return { version: asString(root.pricing_version), groupRatio, entries };
}
