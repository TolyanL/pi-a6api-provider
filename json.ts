/**
 * Defensive accessors for the gateway JSON.
 *
 * Both A6API payloads (`GET /v1/models`, `GET /api/pricing`) are third-party
 * responses, and the gateway is a fork that may add or rename fields between
 * deployments. Every read goes through these helpers, so a shape change drops
 * a field instead of throwing.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

/** Integer field that must be positive to be meaningful (token counts, ratios). */
export function positiveInt(value: unknown): number | undefined {
	const parsed = asNumber(value);
	return parsed !== undefined && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** String values of an array field, forcing nothing: non-strings are skipped. */
export function stringList(value: unknown): string[] {
	return asArray(value).filter((item): item is string => typeof item === "string" && item.length > 0);
}
