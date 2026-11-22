/**
 * Gateway edges and failover.
 *
 * A6API serves one gateway from several edges. The public `GET /api/status`
 * lists them under `data.api_info` — the same "API 地址 / 线路" block the site
 * shows — and the catalog snapshot stores that answer, so the list survives an
 * offline start. Every base URL here ends with `/v1`: the gateway publishes
 * roots (`https://api.a6api.vip`) and the request paths are appended to it.
 *
 * A switch is remembered in `~/.pi/agent/a6api-endpoint.json`, keyed by the
 * primary it was made against, so editing `baseUrl` in `a6api.json` retires a
 * stale switch instead of fighting it.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { asArray, asNumber, asRecord, asString } from "./json.ts";

export const DEFAULT_BASE_URL = "https://api.a6api.vip/v1";

/** Unreachable answers in a row before the endpoint is rotated. */
export const FAILOVER_AFTER = 3;

/** How long the "is the primary back" probe may take. */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * Edge reported by `api_info` when this file was written. It is only used when
 * the gateway never got to publish its own list, e.g. a fresh install on a dead
 * primary.
 */
export const KNOWN_ENDPOINTS = ["https://cf.a6api.net/v1"];

/**
 * Image and video edges. They front the same gateway but exist for direct media
 * links, so a chat request must never be routed there.
 */
const MEDIA_EDGE = /图片|视频|media|(?:^|[^a-z])image(?:[^a-z]|$)|(?:^|[^a-z])video(?:[^a-z]|$)/i;

export interface GatewayEndpoint {
	url: string;
	/** Edge name from `api_info.route`, e.g. `CF 线路`. */
	route?: string;
	/** Edge note from `api_info.description`. */
	note?: string;
}

/** Normalize a gateway URL to a base that ends with `/v1`. */
export function withV1(raw: string | undefined): string | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return undefined;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
	const path = url.pathname.replace(/\/+$/, "");
	url.pathname = path.length === 0 ? "/v1" : path.endsWith("/v1") ? path : `${path}/v1`;
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

/** Host of a base URL, for status lines and notices. */
export function endpointHost(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}

/** Edges published by `GET /api/status`. Accepts the envelope and the bare body. */
export function parseGatewayEndpoints(status: unknown): GatewayEndpoint[] {
	const root = asRecord(status);
	const list = asArray(asRecord(root?.data)?.api_info ?? root?.api_info);
	const endpoints: GatewayEndpoint[] = [];
	const seen = new Set<string>();
	for (const raw of list) {
		const entry = asRecord(raw);
		const url = withV1(asString(entry?.url));
		if (!url || seen.has(url)) continue;
		const route = asString(entry?.route);
		const note = asString(entry?.description);
		if (MEDIA_EDGE.test([route, note, url].filter(Boolean).join(" "))) continue;
		seen.add(url);
		endpoints.push({ url, route, note });
	}
	return endpoints;
}

/** Primary first, then the edges the gateway published, then the known ones. */
export function endpointCandidates(
	primary: string,
	discovered: readonly GatewayEndpoint[] = [],
): GatewayEndpoint[] {
	const candidates: GatewayEndpoint[] = [];
	const seen = new Set<string>();
	const push = (raw: string | undefined, route?: string, note?: string): void => {
		const url = withV1(raw);
		if (!url || seen.has(url)) return;
		seen.add(url);
		candidates.push({ url, route, note });
	};
	push(primary);
	for (const endpoint of discovered) push(endpoint.url, endpoint.route, endpoint.note);
	for (const url of KNOWN_ENDPOINTS) push(url);
	return candidates;
}

/** Candidates in the order to try after `current`, wrapping around. */
export function rotationFrom(
	candidates: readonly GatewayEndpoint[],
	current: string,
): GatewayEndpoint[] {
	const active = withV1(current);
	const index = candidates.findIndex((candidate) => candidate.url === active);
	const ordered =
		index < 0 ? [...candidates] : [...candidates.slice(index + 1), ...candidates.slice(0, index)];
	return ordered.filter((candidate) => candidate.url !== active);
}

// ─── Remembered endpoint ─────────────────────────────────────────────

export interface EndpointState {
	/** Base URL requests go to now. */
	baseUrl: string;
	/** Primary this switch was made against; another primary retires it. */
	primary: string;
	since: number;
	/** Why the switch happened, e.g. `failover after 3 unreachable requests`. */
	reason?: string;
}

let cache: { state: EndpointState | undefined } | undefined;

export function endpointStatePath(): string {
	return join(getAgentDir(), "a6api-endpoint.json");
}

function readStateFromDisk(): EndpointState | undefined {
	try {
		const root = asRecord(JSON.parse(readFileSync(endpointStatePath(), "utf8")) as unknown);
		const baseUrl = withV1(asString(root?.baseUrl));
		const primary = withV1(asString(root?.primary));
		if (!baseUrl || !primary) return undefined;
		return { baseUrl, primary, since: asNumber(root?.since) ?? 0, reason: asString(root?.reason) };
	} catch {
		return undefined;
	}
}

/** Cached read: `resolveBaseUrl` runs once per model definition. */
export function readEndpointState(): EndpointState | undefined {
	cache ??= { state: readStateFromDisk() };
	return cache.state;
}

/** Drop the cache, e.g. at `session_start` when another process may have switched. */
export function refreshEndpointState(): void {
	cache = undefined;
}

export function writeEndpointState(state: EndpointState): void {
	cache = { state };
	try {
		mkdirSync(dirname(endpointStatePath()), { recursive: true });
		writeFileSync(endpointStatePath(), JSON.stringify(state), "utf8");
	} catch (error) {
		console.warn(
			`[a6api] could not write ${endpointStatePath()}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function clearEndpointState(): void {
	cache = { state: undefined };
	rmSync(endpointStatePath(), { force: true });
}

// ─── Failure classification ──────────────────────────────────────────

/**
 * Answers that prove the edge is alive: throttling, auth, quota and billing
 * belong to the account, so rotating the endpoint would not help.
 */
const REACHABLE_FAILURE =
	/(?<![a-z0-9])(?:429)(?![a-z0-9])|rate.?limit|too many requests|overloaded|capacity|servers? (?:are )?(?:currently )?busy|insufficient_quota|quota exceeded|out of budget|billing|invalid.?api.?key|unauthori[sz]ed|forbidden/i;

/**
 * Did this failure mean "the gateway could not be reached"? Uses pi's own
 * transient-failure classifier (`isRetryableAssistantError`) minus the answers
 * that prove the edge answered.
 */
export function isUnreachableFailure(message: { stopReason?: string; errorMessage?: string }): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	if (REACHABLE_FAILURE.test(message.errorMessage)) return false;
	return isRetryableAssistantError({
		stopReason: "error",
		errorMessage: message.errorMessage,
	} as AssistantMessage);
}

/** Liveness of an edge: the public status endpoint answers. */
export async function probeEndpoint(
	baseUrl: string,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
	try {
		const url = new URL("/api/status", baseUrl).toString();
		const response = await fetch(url, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		return response.ok;
	} catch {
		return false;
	}
}
