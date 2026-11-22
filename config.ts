/**
 * Optional user configuration: `~/.pi/agent/a6api.json`.
 *
 * ```json
 * {
 *   "baseUrl": "https://api.a6api.vip/v1",
 *   "failover": true,
 *   "hidden": ["some-model"],
 *   "models": {
 *     "gpt-5.2": {
 *       "contextWindow": 400000,
 *       "maxTokens": 128000,
 *       "compat": { "supportsReasoningEffort": true }
 *     }
 *   }
 * }
 * ```
 *
 * The file is optional and re-read on every refresh, so edits apply without a
 * pi restart. A malformed file is reported once and ignored. Override the
 * location with `PI_A6API_CONFIG` (used by the tests).
 *
 * `baseUrl` is the primary edge. A failover to another edge is remembered in
 * `a6api-endpoint.json` (see `endpoints.ts`) and wins over it until the
 * primary answers again or the primary in this file changes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BASE_URL, readEndpointState, withV1 } from "./endpoints.ts";
import { asBoolean, asNumber, asRecord, asString, positiveInt, stringList } from "./json.ts";

/** Re-exported: the default edge moved to `endpoints.ts` with the rest of them. */
export { DEFAULT_BASE_URL };

export interface ModelOverride {
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	vision?: boolean;
	/** Hide the model from the picker and from pi's model list. */
	hidden?: boolean;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	compat?: OpenAICompletionsCompat;
}

export interface A6ApiConfig {
	/** Primary edge; a remembered failover wins until it is retired. */
	baseUrl?: string;
	/** Rotate the edge when requests cannot reach the gateway. Default: on. */
	failover?: boolean;
	/** Unreachable answers in a row before rotating. Default: 3. */
	failoverAfter?: number;
	/** Ids that should never be registered, e.g. models the gateway lists but rejects. */
	hidden: string[];
	models: Record<string, ModelOverride>;
}

let warnedAboutConfig = false;

export function configPath(): string {
	const override = process.env.PI_A6API_CONFIG;
	return override && override.trim().length > 0 ? override : join(getAgentDir(), "a6api.json");
}

function parseCost(raw: unknown): ModelOverride["cost"] | undefined {
	const cost = asRecord(raw);
	if (!cost) return undefined;
	const parsed: NonNullable<ModelOverride["cost"]> = {};
	const input = asNumber(cost.input);
	const output = asNumber(cost.output);
	const cacheRead = asNumber(cost.cacheRead);
	const cacheWrite = asNumber(cost.cacheWrite);
	if (input !== undefined) parsed.input = input;
	if (output !== undefined) parsed.output = output;
	if (cacheRead !== undefined) parsed.cacheRead = cacheRead;
	if (cacheWrite !== undefined) parsed.cacheWrite = cacheWrite;
	return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseOverride(raw: unknown): ModelOverride | undefined {
	const entry = asRecord(raw);
	if (!entry) return undefined;
	const override: ModelOverride = {};
	const name = asString(entry.name);
	const contextWindow = positiveInt(entry.contextWindow);
	const maxTokens = positiveInt(entry.maxTokens);
	const reasoning = asBoolean(entry.reasoning);
	const vision = asBoolean(entry.vision);
	const hidden = asBoolean(entry.hidden);
	const cost = parseCost(entry.cost);
	const compat = asRecord(entry.compat);
	if (name !== undefined) override.name = name;
	if (contextWindow !== undefined) override.contextWindow = contextWindow;
	if (maxTokens !== undefined) override.maxTokens = maxTokens;
	if (reasoning !== undefined) override.reasoning = reasoning;
	if (vision !== undefined) override.vision = vision;
	if (hidden !== undefined) override.hidden = hidden;
	if (cost !== undefined) override.cost = cost;
	if (compat !== undefined) override.compat = compat as OpenAICompletionsCompat;
	return Object.keys(override).length > 0 ? override : undefined;
}

/** Read the config file. Missing or malformed files yield an empty config. */
export function loadConfig(): A6ApiConfig {
	const empty: A6ApiConfig = { hidden: [], models: {} };
	const path = configPath();
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return empty;
	}
	if (raw.trim().length === 0) return empty;
	try {
		const parsed: unknown = JSON.parse(raw);
		const root = asRecord(parsed);
		if (!root) throw new Error("expected a JSON object");

		const models: Record<string, ModelOverride> = {};
		for (const [id, value] of Object.entries(asRecord(root.models) ?? {})) {
			const override = parseOverride(value);
			if (override) models[id] = override;
		}

		return {
			baseUrl: asString(root.baseUrl),
			failover: asBoolean(root.failover),
			failoverAfter: positiveInt(root.failoverAfter),
			hidden: stringList(root.hidden),
			models,
		};
	} catch (error) {
		if (!warnedAboutConfig) {
			warnedAboutConfig = true;
			console.warn(
				`[a6api] ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return empty;
	}
}

/** Endpoint the user asked for: `baseUrl` from the config, else the default edge. */
export function primaryBaseUrl(config: A6ApiConfig): string {
	return withV1(config.baseUrl) ?? DEFAULT_BASE_URL;
}

/**
 * Effective API endpoint. A remembered failover wins over the primary, but only
 * while the config still names the same primary: editing `baseUrl` retires the
 * old switch instead of being silently ignored.
 */
export function resolveBaseUrl(config: A6ApiConfig): string {
	const primary = primaryBaseUrl(config);
	const state = readEndpointState();
	if (!state || state.primary !== primary || state.baseUrl === primary) return primary;
	return state.baseUrl;
}
