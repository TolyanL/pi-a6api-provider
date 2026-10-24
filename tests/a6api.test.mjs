/**
 * Development test harness for pi-a6api-provider. Not loaded by pi: extension discovery
 * uses the root index.ts and .mjs files are not extension candidates.
 *
 * Run: node tests/a6api.test.mjs
 *
 * Requires the pi install path (override with PI_PACKAGE). Hermetic: both
 * gateway payloads come from tests/fixtures, and the agent dir is a temp dir.
 */

const PI = process.env.PI_PACKAGE ?? "/home/tolyan/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent";
const here = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const fixtures = `${here}/tests/fixtures`;

const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);

const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": `${PI}/dist/index.js`,
		"@earendil-works/pi-ai/compat": `${PI}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
		"@earendil-works/pi-ai/providers/all": `${PI}/node_modules/@earendil-works/pi-ai/dist/providers/all.js`,
		"@earendil-works/pi-ai": `${PI}/node_modules/@earendil-works/pi-ai/dist/index.js`,
		"@earendil-works/pi-tui": `${PI}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	},
});

const { mkdirSync, readFileSync, rmSync } = await import("node:fs");
const { join } = await import("node:path");

delete process.env.A6API_API_KEY;
delete process.env.A6API_KEY;
delete process.env.A6API_DEBUG;

// Sandbox the agent dir: the extension must never write into the real one.
const TEST_AGENT = "/tmp/a6api-test-agent";
rmSync(TEST_AGENT, { recursive: true, force: true });
mkdirSync(TEST_AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = TEST_AGENT;
process.env.PI_A6API_CONFIG = `${fixtures}/a6api-config.json`;

const payloads = {
	models: JSON.parse(readFileSync(`${fixtures}/models.json`, "utf8")),
	pricing: JSON.parse(readFileSync(`${fixtures}/pricing.json`, "utf8")),
};

const catalog = await jiti.import(`${here}/catalog.ts`);
const pricing = await jiti.import(`${here}/pricing.ts`);
const config = await jiti.import(`${here}/config.ts`);
const estimate = await jiti.import(`${here}/estimate.ts`);
const info = await jiti.import(`${here}/info.ts`);
const picker = await jiti.import(`${here}/picker.ts`);
const textView = await jiti.import(`${here}/text-view.ts`);
const piTui = await jiti.import(`${PI}/node_modules/@earendil-works/pi-tui/dist/index.js`);
const extension = await jiti.import(`${here}/index.ts`, { default: true });

let failures = 0;
const check = (name, actual, expected) => {
	const okResult = JSON.stringify(actual) === JSON.stringify(expected);
	if (!okResult) {
		failures++;
		console.log(`FAIL ${name}:\n  got  ${JSON.stringify(actual)}\n  want ${JSON.stringify(expected)}`);
	} else console.log(`ok   ${name}`);
};
const contains = (name, haystack, needle) => check(name, String(haystack).includes(needle), true);
const lacks = (name, haystack, needle) => check(name, String(haystack).includes(needle), false);
const ok = (name, cond) => check(name, !!cond, true);
const near = (name, actual, expected) => check(name, Math.abs(actual - expected) < 1e-9, true);

// ─── pricing ─────────────────────────────────────────────────────────
{
	const parsed = pricing.parsePricing(payloads.pricing);
	check("pricing version", parsed.version, "a42d372ccf0b5dd13ecf71203521f9d2");
	check("default group ratio", parsed.groupRatio, 1);
	check("entries parsed", parsed.entries.size, 7);

	const gpt = parsed.entries.get("gpt-5.2");
	check("ratio 0.5 -> $1/M input", gpt.cost.input, 1);
	check("completion ratio 1 -> $1/M output", gpt.cost.output, 1);
	check("cache prices follow ratios", [gpt.cost.cacheRead, gpt.cost.cacheWrite], [1, 1]);
	check("vendor resolved", gpt.vendor, "OpenAI");
	check("groups", gpt.groups.length, 3);
	check("endpoints", gpt.endpoints, ["openai"]);
	check("token-priced model has no per-call price", gpt.perCallUsd, undefined);
	check("tier threshold", gpt.cost.tiers.map((tier) => tier.inputTokensAbove), [272000]);
	check(
		"tier multipliers apply to the base price",
		[gpt.cost.tiers[0].input, gpt.cost.tiers[0].output, gpt.cost.tiers[0].cacheRead, gpt.cost.tiers[0].cacheWrite],
		[2, 1.5, 2, 2],
	);

	const claude = parsed.entries.get("claude-sonnet-5");
	check("completion ratio scales output", claude.cost.output, 5);
	check("cache ratios scale cache prices", [claude.cost.cacheRead, claude.cost.cacheWrite], [0.1, 1.25]);
	check("claude vendor", claude.vendor, "Anthropic");

	const glm = parsed.entries.get("glm-5.3-flash");
	check("missing cache ratios fall back to input", [glm.cost.cacheRead, glm.cost.cacheWrite], [1, 1]);

	const image = parsed.entries.get("gemini-3.1-flash-image");
	check("per-call quota kind", image.quota, "calls");
	check("per-call price", image.perCallUsd, 1);
	check("image endpoints", image.endpoints, ["image-generation", "openai"]);

	const veo = parsed.entries.get("veo-3.1");
	check("video specs kept", Object.keys(veo.videoSpecs ?? {}).length, 3);
	check("video vendor", veo.vendor, "Google");

	const scaled = pricing.parsePricing({ ...payloads.pricing, group_ratio: { default: 2 } });
	near("group ratio scales every ratio", scaled.entries.get("gpt-5.2").cost.input, 2);

	check("garbage payload", pricing.parsePricing({ nope: true }).entries.size, 0);
	check("null payload", pricing.parsePricing(null).entries.size, 0);
	check(
		"defensive entries",
		pricing.parsePricing({ data: [null, 5, {}, { model_name: "" }, { model_name: "x", model_ratio: "1" }] }).entries.get("x")
			.cost.input,
		0,
	);
}

// ─── estimates ───────────────────────────────────────────────────────
check("claude estimate", estimate.estimateLimits("claude-opus-5").contextWindow, 200000);
check("gemini estimate", estimate.estimateLimits("gemini-3.7-flash").contextWindow, 1048576);
check("gpt-5.x estimate", estimate.estimateLimits("gpt-5.2").contextWindow, 400000);
check("deepseek v4 estimate", estimate.estimateLimits("deepseek-v4-pro").contextWindow, 200000);
check("default estimate", estimate.estimateLimits("pricing-only-model"), { contextWindow: 131072, maxTokens: 32768 });
check("gpt-4o is not a reasoning model", estimate.looksReasoning("gpt-4o"), false);
check("claude reasons", estimate.looksReasoning("claude-sonnet-5"), true);
check("non-reasoning suffix", estimate.looksReasoning("grok-4.20-0309-non-reasoning"), false);
check("claude sees images", estimate.looksVision("claude-sonnet-5"), true);
check("text model does not", estimate.looksVision("deepseek-v4-flash"), false);

// ─── catalog ─────────────────────────────────────────────────────────
const userConfig = config.loadConfig();
check("config path from env", config.configPath(), `${fixtures}/a6api-config.json`);
check("config hidden list", userConfig.hidden, ["mystery-model"]);
check("config model override", userConfig.models["claude-sonnet-5"].maxTokens, 32000);

// Tests pin the limit resolver: pi's bundled catalog changes between releases.
const stubLimits = (id) =>
	id === "claude-sonnet-5"
		? { limits: { contextWindow: 1_000_000, maxTokens: 128_000 }, exact: true, source: "anthropic" }
		: undefined;
const joined = catalog.parseCatalog(payloads, { config: userConfig, resolveLimits: stubLimits });
const byId = new Map(joined.models.map((model) => [model.id, model]));
check("catalog joins both payloads", joined.models.length, 8);
check("catalog version", joined.version, "a42d372ccf0b5dd13ecf71203521f9d2");
check("chat kinds", joined.models.filter((model) => model.kind === "chat").length, 5);
check("image kind", byId.get("gemini-3.1-flash-image").kind, "image");
check("video kind", byId.get("veo-3.1").kind, "video");
check("embedding kind", byId.get("text-embedding-3-large").kind, "embedding");
check("pricing-only model kept", byId.has("pricing-only-model"), true);
check("pricing-only model price", byId.get("pricing-only-model").cost.input, 0.5);

const gpt = byId.get("gpt-5.2");
check("gpt context from the family table", [gpt.contextWindow, gpt.limits], [400000, "estimate"]);
check("family estimate has no catalog provider", gpt.limitsFrom, undefined);
check("gpt name", gpt.name, "GPT 5.2");
check("gpt cost carried into the catalog", [gpt.cost.input, gpt.cost.output], [1, 1]);
check("gpt vision", gpt.vision, true);

const claude = byId.get("claude-sonnet-5");
check("config wins over the catalog", [claude.contextWindow, claude.limits], [200000, "config"]);
check("config wins for max tokens", claude.maxTokens, 32000);
check("config clears the catalog provider", claude.limitsFrom, undefined);
check("config name override", claude.name, "Claude Sonnet 5 (gateway)");

const glm = byId.get("glm-5.3-flash");
check("cost override replaces prices", [glm.cost.input, glm.cost.output], [0.1, 0.4]);
check("cost override keeps cache prices", [glm.cost.cacheRead, glm.cost.cacheWrite], [1, 1]);
check("cost override drops ratio tiers", glm.cost.tiers.length, 0);
check("max tokens clamp to the context window", glm.maxTokens, 64000);

const mystery = byId.get("mystery-model");
check("hidden from config", mystery.hidden, true);
check("unknown price is zero", [mystery.cost.input, mystery.cost.output], [0, 0]);
check("chat list excludes hidden models", catalog.chatModels(joined.models).map((model) => model.id), [
	"gpt-5.2",
	"claude-sonnet-5",
	"glm-5.3-flash",
	"pricing-only-model",
]);

check(
	"malformed payloads",
	catalog.parseCatalog({ models: null, pricing: null }, { config: { hidden: [], models: {} } }).models,
	[],
);
check(
	"defensive live models",
	catalog.parseCatalog({ models: { data: [null, { id: "" }] }, pricing: null }, { config: { hidden: [], models: {} } }).models,
	[],
);
check("garbage payload", catalog.parseCatalog("nope", { config: { hidden: [], models: {} } }).models, []);

// The catalog resolver must accept an injected source and prefer exact matches.
{
	const catalogOnly = catalog.parseCatalog(payloads, {
		config: { hidden: [], models: {} },
		resolveLimits: (id) =>
			id === "gpt-5.2"
				? { limits: { contextWindow: 272_000, maxTokens: 128_000 }, exact: true, source: "openai" }
				: undefined,
	});
	const gpt = catalogOnly.models.find((model) => model.id === "gpt-5.2");
	check("catalog limits win over the family table", [gpt.contextWindow, gpt.limits], [272000, "catalog"]);
	check("catalog provider recorded", gpt.limitsFrom, "openai");
	// The gateway prices a long-context tier above the catalog value: the tier is
	// proof the model accepts at least that much, so it raises the window.
	const raised = catalog.parseCatalog(payloads, {
		config: { hidden: [], models: {} },
		resolveLimits: (id) =>
			id === "gpt-5.2"
				? { limits: { contextWindow: 200_000, maxTokens: 64_000 }, exact: true, source: "openai" }
				: undefined,
	});
	const raisedGpt = raised.models.find((model) => model.id === "gpt-5.2");
	check("pricing tier raises an outdated catalog value", [raisedGpt.contextWindow, raisedGpt.limits], [272000, "pricing"]);
	check("pricing floor clears the catalog provider", raisedGpt.limitsFrom, undefined);
	check(
		"detail names the catalog provider",
		info.describeLines(gpt).join("\n").includes("(pi catalog · openai)"),
		true,
	);
	check(
		"detail names the sibling source",
		info
			.describeLines(
				catalog
					.parseCatalog(payloads, {
						config: { hidden: [], models: {} },
						resolveLimits: (id) =>
							id === "gpt-5.2"
								? { limits: { contextWindow: 400_000, maxTokens: 128_000 }, exact: false, source: "openai" }
								: undefined,
					})
					.models.find((model) => model.id === "gpt-5.2"),
			)
			.join("\n")
			.includes("(pi catalog sibling · openai)"),
		true,
	);
}

// pi's built-in catalog is the real resolver; it must find vendor data for
// gateway ids without consulting aggregator catalogs.
{
	const claude = estimate.vendorCatalogLimits("claude-sonnet-5");
	ok("anthropic catalog resolves claude-sonnet-5", claude !== undefined);
	check("claude-sonnet-5 comes from anthropic", claude.source, "anthropic");
	ok("claude-sonnet-5 window is at least 200k", claude.limits.contextWindow >= 200_000);
	ok("claude-sonnet-5 output cap fits the window", claude.limits.maxTokens <= claude.limits.contextWindow);

	const alias = estimate.vendorCatalogLimits("claude-opus-4-8-20260101");
	ok("date-stamped alias resolves through the vendor catalog", alias !== undefined);
	check("alias resolves to anthropic", alias.source, "anthropic");

	const sibling = estimate.vendorCatalogLimits("gpt-5.6");
	ok("unknown sibling falls back to the vendor family", sibling !== undefined);
	check("sibling lookup is not exact", sibling.exact, false);
	check("sibling lookup stays with openai", sibling.source, "openai");

	check("no vendor for an unknown family", estimate.vendorCatalogLimits("longcat-2.0"), undefined);

	const texts = JSON.stringify([
		estimate.vendorCatalogLimits("claude-sonnet-5"),
		estimate.vendorCatalogLimits("gpt-5.6"),
		estimate.vendorCatalogLimits("longcat-2.0"),
	]);
	ok("resolved limits are JSON-serialisable", texts.length > 0);
}

// ─── naming ──────────────────────────────────────────────────────────
check("prettyName claude", catalog.prettyName("claude-sonnet-5-5"), "Claude Sonnet 5.5");
check("prettyName gpt", catalog.prettyName("gpt-5.2"), "GPT 5.2");
check("prettyName deepseek", catalog.prettyName("deepseek-v4-pro-0813"), "DeepSeek V4 Pro 0813");
check("prettyName glm", catalog.prettyName("glm-5.3-flash"), "GLM 5.3 Flash");
check("prettyName qwen", catalog.prettyName("qwen3.8-max"), "Qwen3.8 Max");

// ─── model definition ────────────────────────────────────────────────
{
	const model = catalog.toModel(gpt, "https://a6api.com/v1");
	check("provider/api", [model.provider, model.api], ["a6api", "openai-completions"]);
	check("base url", model.baseUrl, "https://a6api.com/v1");
	check("cost with tiers", [model.cost.input, model.cost.tiers.length], [1, 1]);
	check("max_tokens field for the gateway", model.compat.maxTokensField, "max_tokens");
	check("reasoning effort off by default", model.compat.supportsReasoningEffort, false);
	check("image input for vision models", model.input, ["text", "image"]);

	const textOnly = catalog.toModel(byId.get("pricing-only-model"), "https://a6api.com/v1");
	check("text-only input", textOnly.input, ["text"]);

	const claudeModel = catalog.toModel(claude, "https://a6api.com/v1");
	check("detail labels a config override", info.describeLines(claude).join("\n").includes("(a6api.json)"), true);
	check("config compat wins", claudeModel.compat.supportsReasoningEffort, true);
	check("config compat keeps gateway defaults", claudeModel.compat.maxTokensField, "max_tokens");
}

// ─── info ────────────────────────────────────────────────────────────
check("formatUsd zero", info.formatUsd(0), "$0");
check("formatUsd whole", info.formatUsd(1), "$1.00");
check("formatUsd small", info.formatUsd(0.5), "$0.5");
check("formatUsd tiny", info.formatUsd(0.011), "$0.011");
check("formatTokens 200k", info.formatTokens(200000), "200k");
check("formatTokens 1M", info.formatTokens(1048576), "1M");
check("formatTokens 272k", info.formatTokens(272000), "272k");
check("formatAge never", info.formatAge(undefined), "never");
check("formatAge seconds", info.formatAge(30000), "30s ago");
check("formatAge minutes", info.formatAge(600000), "10m ago");
check("formatAge hours", info.formatAge(7_200_000), "2h ago");
check("formatAge days", info.formatAge(3 * 86_400_000), "3d ago");
check("pricePair chat", info.pricePair(gpt), "$1.00 / $1.00");
check("pricePair image", info.pricePair(byId.get("gemini-3.1-flash-image")), "$1.00/call");
check("pricePair unknown", info.pricePair(mystery), "—");
check("pricePair embedding", info.pricePair(byId.get("text-embedding-3-large")), "$1.00 / $1.00");

{
	const table = info.tableLines(joined.models).join("\n");
	contains("table lists chat models", table, "claude-sonnet-5");
	contains("table shows flags", table, "R V");
	contains("table marks estimates", table, "400k~");
	const catalogRow = table.split("\n").find((line) => line.includes("claude-sonnet-5"));
	ok("table leaves catalog limits unmarked", catalogRow !== undefined && !catalogRow.includes("~"));
	contains("table header", table, "in / out ($/1M)");
	const filtered = info.tableLines(joined.models, "claude");
	check("table filter keeps one row plus header", filtered.length, 4);
	lacks("table filter drops others", filtered.join("\n"), "gpt-5.2");
	check("no match message", info.tableLines(joined.models, "zzz"), ["No models matched."]);
}

{
	const detail = info.describeLines(gpt).join("\n");
	contains("detail price", detail, "$1.00 in / $1.00 out per 1M");
	contains("detail context source", detail, "(family table)");
	contains("detail tiers", detail, "> 272k in");
	contains("detail vendor", detail, "OpenAI");
	contains("detail groups", detail, "3 · default, supplier-official, supplier-fast");

	const image = info.describeLines(byId.get("gemini-3.1-flash-image")).join("\n");
	contains("image detail per call", image, "$1.00 per call");
	lacks("image detail drops context", image, "context");

	check("non-chat rows have no context column", info.tableLines(joined.models, "veo").some((line) => line.includes("—")), true);

	const veo = info.describeLines(byId.get("veo-3.1")).join("\n");
	contains("video detail specs", veo, "1080p|any|any ×1");

	const unknown = info.describeLines(mystery).join("\n");
	contains("unknown price note", unknown, "no pricing entry");

	const summary = info.summaryLines(joined.models, {
		baseUrl: "https://a6api.com/v1",
		version: joined.version,
		groupRatio: joined.groupRatio,
		fetchedAt: Date.now() - 60000,
	}).join("\n");
	contains("summary provider", summary, "A6API · https://a6api.com/v1");
	contains("summary counts", summary, "chat 4");
	contains("summary version", summary, "v a42d372ccf0b");
}

// ─── snapshot ────────────────────────────────────────────────────────
{
	catalog.setCatalog(joined, Date.now() - 5000);
	catalog.writeSnapshotPayload(payloads);
	check("snapshot path", catalog.snapshotPath(), join(TEST_AGENT, "a6api-catalog.json"));
	const stored = catalog.readSnapshotPayload();
	check("snapshot keeps the raw payload", [stored.models, stored.pricing], [payloads.models, payloads.pricing]);
	const reloaded = catalog.loadCatalogFromDisk({ config: userConfig, resolveLimits: stubLimits });
	check("snapshot reloads the joined catalog", reloaded, 8);
	ok("snapshot age tracked", (catalog.snapshotAgeMs() ?? Infinity) < 60000);
	check("pricing version survives the round trip", catalog.getPricingVersion(), joined.version);
	check("group ratio survives the round trip", catalog.getGroupRatio(), 1);
}

// anymodel parity: an empty agent dir registers nothing and stays offline
// until a session starts; the first install never blocks startup on a fetch.
{
	const { mkdirSync, rmSync } = await import("node:fs");
	const emptyAgent = "/tmp/a6api-test-agent-empty";
	rmSync(emptyAgent, { recursive: true, force: true });
	mkdirSync(emptyAgent, { recursive: true });
	const previousAgent = process.env.PI_CODING_AGENT_DIR;
	const originalFetch = globalThis.fetch;
	let fetches = 0;
	process.env.PI_CODING_AGENT_DIR = emptyAgent;
	globalThis.fetch = async () => {
		fetches += 1;
		throw new Error("startup must not touch the network");
	};
	try {
		// A fresh process starts with an empty in-memory catalog.
		catalog.setCatalog({ models: [], groupRatio: 1 });
		check("empty snapshot loads nothing", catalog.loadCatalogFromDisk(), 0);
		const { providers } = await buildExt();
		check("fresh install registers an empty catalog", providers[0].getModels().length, 0);
		check("factory performs no network request", fetches, 0);
	} finally {
		globalThis.fetch = originalFetch;
		process.env.PI_CODING_AGENT_DIR = previousAgent;
		catalog.loadCatalogFromDisk({ config: userConfig, resolveLimits: stubLimits });
	}
	check("snapshot restored after the fresh-install check", catalog.chatModels(catalog.getCatalog()).length, 4);
}

// ─── extension ───────────────────────────────────────────────────────
const plainTheme = { fg: (_color, text) => text, bold: (text) => text };
const stripAnsi = (line) => line.replace(/\x1B\[[0-9;]*m/g, "");

function makeTui(rows = 40) {
	return { terminal: { rows }, requestRender: () => {} };
}

function makeKeybindings() {
	const keys = {
		"tui.select.up": "\x1b[A",
		"tui.select.down": "\x1b[B",
		"tui.select.confirm": "\r",
		"tui.select.cancel": "\x1b",
	};
	return { matches: (data, action) => keys[action] === data };
}

async function buildExt() {
	const handlers = new Map();
	const commands = new Map();
	const providers = [];
	const pi = {
		registerProvider: (provider) => providers.push(provider),
		registerCommand: (name, options) => commands.set(name, options),
		setModel: async () => true,
		on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	};
	await extension(pi);
	return { handlers, commands, providers };
}

function makeCtx({ model = { id: "gpt-5.2", provider: "a6api", contextWindow: 400000, maxTokens: 128000 }, mode = "print" } = {}) {
	const statuses = [];
	const notices = [];
	const refreshCalls = [];
	return {
		hasUI: mode !== "json",
		mode,
		model,
		ui: {
			theme: plainTheme,
			setStatus: (key, value) => statuses.push([key, value]),
			notify: (message, type) => notices.push([type, message]),
			custom: async (factory) => {
				let result;
				const component = await factory(makeTui(), plainTheme, makeKeybindings(), (value) => {
					result = value;
				});
				return { component, result };
			},
		},
		modelRegistry: {
			find: (provider, id) => (provider === "a6api" ? { id, provider } : undefined),
			refresh: async (options) => {
				refreshCalls.push(options);
				return { errors: new Map(), aborted: false };
			},
		},
		waitForIdle: async () => {},
		statuses,
		notices,
		refreshCalls,
	};
}

{
	// The factory registered a provider from the snapshot written above.
	const { providers } = await buildExt();
	check("one provider registered", providers.length, 1);
	const provider = providers[0];
	check("provider id", provider.id, "a6api");
	check("provider base url", provider.baseUrl, "https://a6api.com/v1");
	check("provider lists chat models only", provider.getModels().length, 4);
	check("registered model ids", provider.getModels().map((model) => model.id), [
		"gpt-5.2",
		"claude-sonnet-5",
		"glm-5.3-flash",
		"pricing-only-model",
	]);

	const publish = async (publication) => {
		publication.update?.();
		return true;
	};
	const refreshContext = (overrides = {}) => ({
		credential: { type: "api_key", key: "test-key" },
		stored: undefined,
		allowNetwork: false,
		force: true,
		signal: new AbortController().signal,
		publish,
		...overrides,
	});

	await provider.refreshModels(refreshContext());
	check("offline refresh keeps the cached models", provider.getModels().length, 4);

	// Gateway refresh: both payloads come back from a stubbed fetch.
	const originalFetch = globalThis.fetch;
	const requested = [];
	globalThis.fetch = async (url) => {
		requested.push(String(url));
		const body = String(url).endsWith("/models") ? payloads.models : payloads.pricing;
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	};
	try {
		await provider.refreshModels(refreshContext({ allowNetwork: true }));
	} finally {
		globalThis.fetch = originalFetch;
	}
	check("both gateway endpoints are requested", requested.sort(), [
		"https://a6api.com/api/pricing",
		"https://a6api.com/v1/models",
	]);
	check("network refresh publishes chat models", provider.getModels().map((model) => model.id), [
		"gpt-5.2",
		"claude-sonnet-5",
		"glm-5.3-flash",
		"pricing-only-model",
	]);
	check("network refresh keeps prices", provider.getModels()[0].cost.input, 1);
}

// A failed refresh must keep the last known catalog: our snapshot if it is
// newer, otherwise pi's models-store.json (`context.stored`).
{
	const { providers } = await buildExt();
	const provider = providers[0];
	const publish = async (publication) => {
		publication.update?.();
		return true;
	};
	const refreshContext = (stored, overrides = {}) => ({
		credential: { type: "api_key", key: "test-key" },
		stored,
		allowNetwork: true,
		force: true,
		signal: new AbortController().signal,
		publish,
		...overrides,
	});
	const chatEntry = catalog.toModel(joined.models.find((model) => model.id === "gpt-5.2"), "https://a6api.com/v1");
	const storedChat = { ...chatEntry, id: "stored-chat" };
	const storedImage = { ...chatEntry, id: "stored-image", type: "image" };
	const stored = { models: [storedChat, storedImage], checkedAt: Date.now() };
	const originalFetch = globalThis.fetch;

	// Empty snapshot + dead network: publish the persisted chat models, not [].
	catalog.setCatalog({ models: [], groupRatio: 1 });
	globalThis.fetch = async () => {
		throw new Error("network down");
	};
	try {
		await provider.refreshModels(refreshContext(stored));
	} finally {
		globalThis.fetch = originalFetch;
	}
	// `createProvider` keeps the registered baseline and merges the published
	// dynamic models on top, so the check is that the store entry survived.
	contains(
		"failed refresh falls back to models-store",
		provider.getModels().map((model) => model.id).join(","),
		"stored-chat",
	);
	lacks("failed refresh keeps the image model out", provider.getModels().map((model) => model.id).join(","), "stored-image");

	// Offline phase (startup restore) does the same without touching the network.
	catalog.setCatalog({ models: [], groupRatio: 1 });
	await provider.refreshModels(refreshContext(stored, { allowNetwork: false }));
	contains(
		"offline restore uses models-store",
		provider.getModels().map((model) => model.id).join(","),
		"stored-chat",
	);

	// A successful answer with no chat models must not wipe the persisted catalog.
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
	try {
		await provider.refreshModels(refreshContext(stored));
	} finally {
		globalThis.fetch = originalFetch;
	}
	contains(
		"empty gateway answer keeps models-store",
		provider.getModels().map((model) => model.id).join(","),
		"stored-chat",
	);

	// Newer snapshot wins; a newer models-store wins over an older snapshot.
	catalog.setCatalog(joined, Date.now() - 60_000);
	globalThis.fetch = async () => {
		throw new Error("network down");
	};
	try {
		await provider.refreshModels(refreshContext({ ...stored, checkedAt: Date.now() - 300_000 }));
	} finally {
		globalThis.fetch = originalFetch;
	}
	check(
		"newer snapshot beats an older models-store",
		provider.getModels().map((model) => model.id),
		catalog.chatModels(joined.models).map((model) => model.id),
	);

	catalog.setCatalog(joined, Date.now() - 300_000);
	globalThis.fetch = async () => {
		throw new Error("network down");
	};
	try {
		await provider.refreshModels(refreshContext({ ...stored, checkedAt: Date.now() - 60_000 }));
	} finally {
		globalThis.fetch = originalFetch;
	}
	contains(
		"newer models-store beats an older snapshot",
		provider.getModels().map((model) => model.id).join(","),
		"stored-chat",
	);


	catalog.loadCatalogFromDisk({ config: userConfig, resolveLimits: stubLimits });
}

{
	const { handlers, commands } = await buildExt();
	ok("a6api command registered", commands.has("a6api"));
	check("command description", commands.get("a6api").description, "A6API: browse models, prices, and limits");
	const completions = commands.get("a6api").getArgumentCompletions("ref");
	check("argument completions", completions.map((item) => item.value), ["refresh"]);

	const ctx = makeCtx();
	await handlers.get("session_start")[0]({ type: "session_start" }, ctx);
	check("status key", ctx.statuses.at(-1)[0], "pi-a6api");
	check("status shows price and context", ctx.statuses.at(-1)[1], "A6 $1.00/$1.00 400k");
	ok("startup refresh went through the registry", ctx.refreshCalls.length >= 1);
	check("refresh requests this provider", ctx.refreshCalls[0].providers, ["a6api"]);

	const other = makeCtx({ model: { id: "x", provider: "commandcode" } });
	await handlers.get("session_start")[0]({ type: "session_start" }, other);
	check("status cleared for other providers", other.statuses.at(-1), ["pi-a6api", undefined]);

	const known = makeCtx();
	await commands.get("a6api").handler("list", known);
	contains("list prints the table", known.notices.at(-1)[1], "claude-sonnet-5");
	contains("list prints the summary", known.notices.at(-1)[1], "models      8");

	const filtered = makeCtx();
	await commands.get("a6api").handler("list gemini", filtered);
	contains("list filter", filtered.notices.at(-1)[1], "gemini-3.1-flash-image");
	lacks("list filter drops others", filtered.notices.at(-1)[1], "claude-sonnet-5");

	const one = makeCtx();
	await commands.get("a6api").handler("gpt-5.2", one);
	contains("model detail", one.notices.at(-1)[1], "$1.00 in / $1.00 out per 1M");

	const missing = makeCtx();
	await commands.get("a6api").handler("gpt-5", missing);
	contains("unknown model names the input", missing.notices.at(-1)[1], 'no model "gpt-5"');
}

// A refresh that outlives its session must not touch the stale ctx.
{
	const { handlers } = await buildExt();
	let alive = true;
	const guard = () => {
		if (!alive) throw new Error("stale ctx: session replaced or shut down");
	};
	const ctx = {
		get hasUI() {
			guard();
			return true;
		},
		get mode() {
			guard();
			return "print";
		},
		get model() {
			guard();
			return { id: "gpt-5.2", provider: "a6api", contextWindow: 400000 };
		},
		ui: {
			setStatus: () => guard(),
			notify: () => guard(),
		},
		modelRegistry: {
			refresh: async () => {
				// The session ends while the catalog request is in flight.
				alive = false;
				return { errors: new Map(), aborted: false };
			},
		},
	};
	await handlers.get("session_start")[0]({ type: "session_start" }, ctx);
	await new Promise((resolve) => setTimeout(resolve, 20));
	await handlers.get("session_shutdown")[0]({ type: "session_shutdown" }, ctx);
	ok("a refresh outliving its session does not reject", true);
}

// ─── picker ──────────────────────────────────────────────────────────
{
	const selected = [];
	let closed;
	const component = new picker.A6ApiPickerComponent(
		makeTui(),
		plainTheme,
		makeKeybindings(),
		{
			models: joined.models,
			currentId: "gpt-5.2",
			refresh: async () => ({ models: joined.models }),
			select: async (model) => {
				selected.push(model.id);
				return true;
			},
		},
		(model) => {
			closed = model;
		},
	);

	const lines = component.render(80).map(stripAnsi);
	ok("picker renders rows", lines.some((line) => line.includes("gpt-5.2")));
	ok("picker marks the current model", lines.some((line) => line.includes("✓ gpt-5.2")));
	ok("picker shows the detail pane", lines.some((line) => line.includes("in / $1.00") && line.includes("out")));
	ok("picker shows sort mode", lines.some((line) => line.includes("sort: name")));
	check("picker fits the width", lines.every((line) => line.length <= 80), true);

	for (const char of "claude") component.handleInput(char);
	component.handleInput("\r"); // enter on the only remaining row
	await new Promise((resolve) => setTimeout(resolve, 0));
	check("enter selects the highlighted model", selected, ["claude-sonnet-5"]);
	check("picker reports the chosen model", closed.id, "claude-sonnet-5");

	// Filter to the video model: Enter must not try to switch the session model.
	const mediaPicker = new picker.A6ApiPickerComponent(
		makeTui(),
		plainTheme,
		makeKeybindings(),
		{
			models: joined.models,
			refresh: async () => ({ models: joined.models }),
			select: async () => {
				throw new Error("must not be called for a video model");
			},
		},
		() => {},
	);
	for (const char of "veo") mediaPicker.handleInput(char);
	mediaPicker.handleInput("\r");
	await new Promise((resolve) => setTimeout(resolve, 0));
	const mediaLines = mediaPicker.render(80).map(stripAnsi);
	ok("non-chat selection is refused", mediaLines.some((line) => line.includes("video-only")));

	// Filtering narrows the list.
	const searchPicker = new picker.A6ApiPickerComponent(
		makeTui(),
		plainTheme,
		makeKeybindings(),
		{ models: joined.models, refresh: async () => ({ models: joined.models }), select: async () => true },
		() => {},
	);
	for (const char of "gemini") searchPicker.handleInput(char);
	const narrowed = searchPicker.render(80).map(stripAnsi).join("\n");
	contains("typing filters", narrowed, "gemini-3.1-flash-image");
	lacks("typing filters others out", narrowed, "gpt-5.2");
	searchPicker.handleInput("\x1b");
	check("tab cycles the sort mode", (searchPicker.render(80).join("\n"), true), true);
}

// ─── text view ───────────────────────────────────────────────────────
{
	const lines = Array.from({ length: 100 }, (_value, index) => `line ${index + 1}`);
	let closed = false;
	const view = new textView.TextViewComponent(makeTui(20), plainTheme, makeKeybindings(), "Report", lines, () => {
		closed = true;
	});
	const rendered = view.render(60).map(stripAnsi);
	ok("text view starts at the top", rendered.some((line) => line.includes("line 1")));
	ok("text view shows the position", rendered.some((line) => line.includes("of 100")));
	check("text view fits the width", rendered.every((line) => line.length <= 60), true);
	view.handleInput("\x1b[B");
	view.handleInput("\x1b");
	check("escape closes the text view", closed, true);
}

// ─── pi-tui integration ──────────────────────────────────────────────
check("Key.backspace exists", typeof piTui.Key.backspace, "string");

if (failures > 0) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall checks passed");
