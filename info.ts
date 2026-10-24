/**
 * Text rendering for the A6API commands: summary, model table, model details.
 *
 * Plain strings only, so the same report works in the TUI overlay, in
 * `notify()` for RPC/print modes, and in the tests.
 */

import { PROVIDER_NAME, chatModels, type CatalogModel, type ModelKind } from "./catalog.ts";
import type { PricingCost, PricingEntry } from "./pricing.ts";

// ─── Formatting ──────────────────────────────────────────────────────

/** USD with just enough digits to stay meaningful for cheap models. */
export function formatUsd(value: number): string {
	if (!Number.isFinite(value) || value === 0) return "$0";
	if (value >= 1) return `$${value.toFixed(2)}`;
	if (value >= 0.01) return `$${value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
	if (value >= 0.0001) return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
	return `$${value.toExponential(1)}`;
}

export function formatTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens <= 0) return "0";
	if (tokens >= 1_000_000) {
		const millions = tokens / 1_000_000;
		return `${millions >= 10 ? Math.round(millions) : Number(millions.toFixed(1))}M`;
	}
	if (tokens >= 1_000) {
		const thousands = tokens / 1_000;
		return `${thousands >= 10 ? Math.round(thousands) : Number(thousands.toFixed(1))}k`;
	}
	return String(tokens);
}

export function formatAge(ms: number | undefined): string {
	if (ms === undefined) return "never";
	const seconds = Math.round(ms / 1000);
	if (seconds < 90) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 90) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

const KIND_LABELS: Record<ModelKind, string> = {
	chat: "chat",
	image: "image",
	video: "video",
	embedding: "embedding",
};

export function kindLabel(kind: ModelKind): string {
	return KIND_LABELS[kind];
}

/** Price pair shown in the table: in/out per 1M, or per call for generators. */
export function pricePair(entry: CatalogModel): string {
	// A model the gateway published no price for must not read as free.
	if (!entry.pricing) return "—";
	if (entry.pricing.quota === "calls") {
		const perCall = entry.pricing.perCallUsd;
		return perCall === undefined ? "—" : `${formatUsd(perCall)}/call`;
	}
	return `${formatUsd(entry.cost.input)} / ${formatUsd(entry.cost.output)}`;
}

/**
 * Context windows only describe chat models; generators have no request limit.
 * `~` marks a value that is not authoritative: a family-table estimate or a
 * floor inferred from the gateway's long-context pricing.
 */
function limitsLabel(entry: CatalogModel): string {
	if (entry.kind !== "chat") return "—";
	const context = formatTokens(entry.contextWindow);
	return entry.limits === "pricing" || entry.limits === "estimate" ? `${context}~` : context;
}

/** Short label for the limit source in the detail pane. */
function limitsSource(entry: CatalogModel): string {
	const from = entry.limitsFrom ? ` · ${entry.limitsFrom}` : "";
	switch (entry.limits) {
		case "config":
			return "a6api.json";
		case "catalog":
			return `pi catalog${from}`;
		case "pricing":
			return "gateway long-context tier";
		default:
			return entry.limitsFrom ? `pi catalog sibling${from}` : "family table";
	}
}

function flagsLabel(entry: CatalogModel): string {
	const flags: string[] = [];
	if (entry.kind === "chat") {
		if (entry.reasoning) flags.push("R");
		if (entry.vision) flags.push("V");
	}
	if (entry.hidden) flags.push("hidden");
	return flags.join(" ");
}

/** Multipliers are ratios: trim the float noise the gateway's arithmetic leaves. */
function formatScale(value: number): string {
	return String(Number(value.toFixed(3)));
}

// ─── Table ───────────────────────────────────────────────────────────

/** Match a model by id, display name, or vendor, case-insensitively. */
export function matches(model: CatalogModel, filter: string): boolean {
	const needle = filter.trim().toLowerCase();
	if (needle.length === 0) return true;
	return (
		model.id.toLowerCase().includes(needle) ||
		model.name.toLowerCase().includes(needle) ||
		(model.vendor ?? "").toLowerCase().includes(needle) ||
		model.kind.includes(needle)
	);
}

export function filterModels(models: readonly CatalogModel[], filter: string): CatalogModel[] {
	return models.filter((model) => matches(model, filter));
}

function padRight(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
	return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/** Fixed-width table: id, in/out price, context, flags. */
export function tableLines(models: readonly CatalogModel[], filter = ""): string[] {
	const rows = filterModels(models, filter);
	if (rows.length === 0) return ["No models matched."];

	const idWidth = Math.min(38, Math.max(...rows.map((model) => model.id.length), 4));
	const priceWidth = Math.max(...rows.map((model) => pricePair(model).length), 9);
	const lines = [
		`${padRight("model", idWidth)}  ${padRight("in / out ($/1M)", priceWidth)}  ${padLeft("ctx", 6)}  flags`,
	];
	for (const model of rows) {
		const price = padRight(pricePair(model), priceWidth);
		lines.push(`${padRight(model.id, idWidth)}  ${price}  ${padLeft(limitsLabel(model), 6)}  ${flagsLabel(model)}`);
	}
	lines.push("", "R = reasoning, V = image input, ~ = estimated context window");
	return lines;
}

// ─── Details ─────────────────────────────────────────────────────────

function tierLines(cost: PricingCost): string[] {
	return cost.tiers.map(
		(tier) =>
			`  > ${formatTokens(tier.inputTokensAbove)} in: ${formatUsd(tier.input)} / ${formatUsd(tier.output)} per 1M`,
	);
}

function groupsLabel(entry: PricingEntry | undefined): string {
	if (!entry || entry.groups.length === 0) return "—";
	// `default` decides the public price, so it leads; the rest stay in gateway order.
	const ordered = [...entry.groups].sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : 0));
	const shown = ordered.slice(0, 3).join(", ");
	const extra = entry.groups.length > 3 ? `, +${entry.groups.length - 3}` : "";
	return `${entry.groups.length} · ${shown}${extra}`;
}

/** Detail block for one model. */
export function describeLines(model: CatalogModel): string[] {
	const row = (label: string, value: string): string => `  ${padRight(label, 10)}${value}`;
	const lines = [`${model.id} — ${model.name}`];
	lines.push(row("kind", `${kindLabel(model.kind)}${model.endpoints.length > 0 ? ` · ${model.endpoints.join(", ")}` : ""}`));
	if (model.vendor) lines.push(row("vendor", model.vendor));

	const perCall = model.pricing?.perCallUsd;
	if (perCall !== undefined) {
		lines.push(row("price", `${formatUsd(perCall)} per call`));
	} else if (model.pricing) {
		lines.push(row("price", `${formatUsd(model.cost.input)} in / ${formatUsd(model.cost.output)} out per 1M`));
		if (model.cost.cacheRead > 0 || model.cost.cacheWrite > 0) {
			lines.push(
				row("cache", `read ${formatUsd(model.cost.cacheRead)} / write ${formatUsd(model.cost.cacheWrite)} per 1M`),
			);
		}
	} else {
		lines.push(row("price", "not published"));
	}

	const specs = model.pricing?.videoSpecs;
	if (specs) {
		lines.push(row("specs", Object.entries(specs).map(([spec, scale]) => `${spec} ×${formatScale(scale)}`).join(" · ")));
	}

	if (model.kind === "chat") {
		lines.push(
			row(
				"context",
				`${formatTokens(model.contextWindow)} (${limitsSource(model)}) · output ${formatTokens(model.maxTokens)}`,
			),
		);
		const tiers = tierLines(model.cost);
		if (tiers.length > 0) lines.push(row("long ctx", tiers[0]?.trim() ?? ""));
	}
	lines.push(row("groups", groupsLabel(model.pricing)));
	const flags = flagsLabel(model);
	if (flags) lines.push(row("flags", flags));
	if (!model.pricing) lines.push(row("note", "no pricing entry: cost accounting stays at zero"));
	return lines;
}

// ─── Summary ─────────────────────────────────────────────────────────

export interface SummaryMeta {
	baseUrl: string;
	version?: string;
	groupRatio: number;
	fetchedAt?: number;
	now?: number;
}

export function summaryLines(catalog: readonly CatalogModel[], meta: SummaryMeta): string[] {
	const chat = chatModels(catalog).length;
	const count = (kind: ModelKind): number => catalog.filter((model) => model.kind === kind).length;
	const age = meta.fetchedAt === undefined ? undefined : (meta.now ?? Date.now()) - meta.fetchedAt;
	return [
		`${PROVIDER_NAME} · ${meta.baseUrl}`,
		`  models      ${catalog.length} · chat ${chat} · image ${count("image")} · video ${count("video")} · embedding ${count("embedding")}`,
		`  pricing     ${meta.version ? `v ${meta.version.slice(0, 12)}` : "unknown"} · default group ×${meta.groupRatio}`,
		`  snapshot    ${formatAge(age)} (GET /v1/models + GET /api/pricing)`,
	];
}
