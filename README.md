# pi-a6api-provider

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Pi extension](https://img.shields.io/badge/pi-extension-blueviolet.svg)](https://pi.dev)

An [A6API](https://a6api.com) provider and model browser for [Pi](https://pi.dev). A6API is an OpenAI-compatible model gateway — a new-api fork that fans out to OpenAI, Anthropic, Google, DeepSeek, Moonshot, Zhipu, Qwen, xAI, and others.

The extension does two things:

1. **Provider `a6api`** with a catalog discovered from the gateway, so its models appear in `/model`, `Ctrl+P` and `/models` like a built-in provider, with real prices in the footer and in `/session`.
2. **Model info**: `/a6api` opens a searchable model browser — price per million tokens, cache prices, long-context tiers, context/output limits, vendor, gateway groups, and per-call prices for image/video models.

## Features

- **Provider `a6api`** — models come from `GET /v1/models` and are registered like built-ins, so every model picker in Pi works unchanged.
- **Real prices** — the gateway's ratios are converted to USD per million tokens (input, output, cache read/write, long-context tiers), and Pi's own cost accounting uses those numbers.
- **Model browser** — `/a6api` with fuzzy filtering, sort order by name / cheapest / largest context, and a detail pane that names the source of every limit.
- **Context estimates** — windows and output limits come from Pi's own vendor catalogs (or a sibling model), then the gateway's long-context floor, then a small family table.
- **Offline-safe catalog** — the raw payload is snapshotted to `~/.pi/agent/a6api-catalog.json`; on a failed refresh the newer of that snapshot and Pi's persisted catalog is used.
- **Per-model overrides** — `a6api.json` can fix a context window, an output limit, prices, capability flags, or hide a model entirely.

## Requirements

- [Pi](https://pi.dev) with extension support; interactive TUI mode for the browser.
- An A6API API key: `/login` → *A6API API key*, or `A6API_API_KEY` / `A6API_KEY` in the environment.
- Network access on the first launch — afterwards the snapshot works offline.

No build step and no runtime dependencies: Pi loads the TypeScript entry point directly. `@earendil-works/pi-ai`, `pi-coding-agent`, and `pi-tui` are declared as peer dependencies provided by the host.

## Installation

```sh
pi install git:github.com/TolyanL/pi-a6api-provider
```

Pin a tag or commit:

```sh
pi install git:github.com/TolyanL/pi-a6api-provider@v1.0.0
```

Try it for a single invocation without touching your settings:

```sh
pi -e git:github.com/TolyanL/pi-a6api-provider
```

From a local clone:

```sh
git clone https://github.com/TolyanL/pi-a6api-provider
pi install ./pi-a6api-provider
```

Restart Pi, or run `/reload`, after changing the extension. The package is npm-shaped (`keywords: ["pi-package"]`), so `pi install npm:pi-a6api-provider` works the same way if you publish it.

During development the extension can also be discovered from `~/.pi/agent/extensions/pi-a6api-provider` (a symlink to a clone) or loaded with `pi --extension ~/.pi/agent/extensions/pi-a6api-provider`. Load it **once**: Pi rejects duplicate tool names, so combining discovery with an explicit `--extension` for the same path fails.

## Usage

Connect the API key once (stored in `~/.pi/agent/auth.json`, never in git):

```text
/login
# → A6API API key
```

Alternatively set `A6API_API_KEY` (or `A6API_KEY`) in the environment. Then pick a model:

```text
/model
# → a6api/gpt-5.2, a6api/claude-sonnet-5, …
```

The catalog snapshot is built by the first session (a background refresh at session start) or by `/a6api refresh`; until then the provider lists no models, exactly like `pi-anymodel-provider` before its first refresh.

## Commands

| Command | Effect |
| --- | --- |
| `/a6api` | Model browser: filter, sort, details; enter switches the session model |
| `/a6api list [filter]` | Plain table (id, in/out price, context, flags), scrollable overlay |
| `/a6api <model>` | Details for one model, e.g. `/a6api claude-sonnet-5` |
| `/a6api refresh` | Reload `GET /v1/models` and `GET /api/pricing` |

Picker keys: `↑↓` move, `⏎` use model, `esc` close, typing filters, `tab` cycles sort (name / cheapest / largest context), `ctrl+r` refreshes.

Image, video, and embedding models are listed with their price but cannot be selected as the session model — the gateway bills them per call and serves them from `/v1/images/generations` or `/v1/videos`, which Pi does not drive.

The footer status shows the live price of the current model (`A6 $1.00/$5.00 200k`). Pi's own cost accounting uses the same numbers, so the session cost is A6API's price, not the upstream vendor's list price.

## Configuration

Optional `~/.pi/agent/a6api.json`, re-read on every refresh:

```json
{
  "baseUrl": "https://a6api.com/v1",
  "hidden": ["some-model"],
  "models": {
    "gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000,
      "reasoning": true,
      "vision": true,
      "compat": { "supportsReasoningEffort": true }
    }
  }
}
```

| Key | Meaning |
| --- | --- |
| `baseUrl` | Endpoint override, e.g. a regional gateway (`https://api.a6api.com/v1`) |
| `hidden` | Ids that are never registered with Pi |
| `models.<id>.name` | Display name |
| `models.<id>.contextWindow` | Context window, overrides the estimate |
| `models.<id>.maxTokens` | Output limit, clamped to the context window |
| `models.<id>.reasoning` / `.vision` | Capability flags |
| `models.<id>.cost` | USD per 1M tokens override (`input`, `output`, `cacheRead`, `cacheWrite`) |
| `models.<id>.compat` | Extra `openai-completions` compatibility flags |
| `models.<id>.hidden` | Hide just this model |

`A6API_CATALOG_TTL_MS` controls snapshot freshness (default one hour), `A6API_PRICING_URL` points at a different pricing endpoint, `A6API_DEBUG=1` logs refresh decisions to stderr, and `PI_A6API_CONFIG` relocates the config file (used by the tests).

## Where the numbers come from

The data flow mirrors `pi-anymodel-provider`: **one** `fetchCatalogPayload()` per refresh returns the raw payload, `writeSnapshotPayload()` stores it verbatim in `~/.pi/agent/a6api-catalog.json`, `parseCatalog()` turns it into models, and `loadCatalogFromDisk()` restores it before the provider registers.

Refreshing is launch-driven: every Pi start performs a **forced** refresh (`force: true` bypasses the TTL), with up to three attempts and 600 ms backoff. `A6API_CATALOG_TTL_MS` (default 1h) only gates Pi's own mid-session refresh triggers, such as opening `/model`; set it to `0` to refetch on those too. `/a6api refresh` and `ctrl+r` in the browser always force a fetch.

When a refresh fails, Pi keeps whatever the provider published last and the extension returns the **newer of two caches** instead of an empty list: the raw snapshot (`a6api-catalog.json`) and Pi's own persisted catalog (`models-store.json`, handed to the provider as `context.stored`). Returning `[]` is never an option — Pi persists whatever `fetchModels` returns, so an empty answer would wipe the offline catalog. An empty or partial gateway reply is treated the same way as an error.

The payload itself has two halves, because A6API publishes less than AnyModel in one place:

- `models` — `GET /v1/models` (needs the key): what this token may call, with the endpoint types the gateway exposes per model;
- `pricing` — `GET /api/pricing` (public): ratios, groups, vendors, long-context tiers, per-call prices.

Both are fetched together and stored as one payload `{ models, pricing }`, then joined here; a model listed by only one of them still appears, with the missing half marked as unknown.

### Pricing ratios

The gateway publishes **ratios**, not money. Its own model page converts them as `usd_per_million = ratio * 2 * group_ratio` (ratio `0.5` → `$1/M`), which is what this extension applies, together with `completion_ratio` for output, `cache_ratio`/`create_cache_ratio` for cache reads/writes, and the multipliers in `long_context_pricing` mapped onto Pi's cost tiers. Prices are the public `default`-group prices; a token in a special group can pay less.

### Context windows and output limits

**These are not published by the gateway.** They are resolved, in order, from:

1. `models.<id>.contextWindow`/`maxTokens` in the config file,
2. **Pi's own built-in catalog for the model's vendor** — the data Pi uses for native providers, matched by id (`claude-sonnet-5` → `anthropic`, `gpt-5.4` → `openai`, `qwen3.8-max` → Alibaba's Qwen plan catalog, `mimo-*` → `xiaomi`, …). Aggregator catalogs (opencode, github-copilot, openrouter) are never consulted, because they list foreign models with their own limits,
3. the closest sibling in that vendor catalog when the exact id is newer than the catalog (`gpt-5.6` → `gpt-5.6-sol`, `gemini-3-pro-preview` → the Gemini 3 generation),
4. `long_context_pricing.threshold` from the gateway as a floor — the gateway charging a long-context tier proves the model accepts that much,
5. a small family table for models no source knows (`longcat-*`, `step-*`, `hy*`, `claude-mythos-5`, …).

So the values are not uniform: on the current catalog `claude-opus-4-8` is 1M, `gpt-5.4` is 272k, `gpt-5.2` is 400k, `grok-4.7` is 500k, `gemini-*` is 1M, `kimi-k3` is 1M, `longcat`/`step`/`hy` are 131k. The info command shows the source in the detail pane (`pi catalog · anthropic`, `pi catalog sibling · openai`, `gateway long-context tier`, `family table`, `a6api.json`) and marks the weak sources with `~` in the table. Override any model in `a6api.json` when the estimate is wrong for the upstream you route to.

### Reasoning effort and request shape

**Reasoning effort is off by default.** A gateway-level `reasoning_effort` breaks the upstreams that do not know the field; thinking content still streams through as `reasoning_content`. Opt in per model with `"compat": { "supportsReasoningEffort": true }`.

Requests are sent with `max_tokens` (not `max_completion_tokens`), which every upstream behind the gateway accepts.

## Limitations

- The first start after installation has no catalog until the refresh completes; offline without a snapshot, the provider lists no models.
- Context windows and output limits are estimates — the gateway does not publish them, so the resolution chain above can be wrong for a newer or rarer model.
- Prices are `default`-group prices; a special-group token pays less, and the extension cannot see the group.
- Image, video, and embedding models are browsable but not callable as the session model.
- The browser is TUI-only; `/a6api list` and `/a6api <model>` still work as plain text elsewhere.

## Layout

| File | Role |
| --- | --- |
| `index.ts` | Provider registration, catalog refresh, status, `/a6api` command |
| `catalog.ts` | Join of both payloads, model definitions, snapshot |
| `pricing.ts` | `GET /api/pricing` parsing and ratio → USD conversion |
| `estimate.ts` | Family table for context/output limits, reasoning, vision |
| `config.ts` | `~/.pi/agent/a6api.json` |
| `info.ts` | Summary, table, and detail text |
| `picker.ts` | TUI model browser |
| `text-view.ts` | Scrollable overlay for long command output |

## Development

```sh
npm test    # node tests/a6api.test.mjs
```

The harness loads the extension through Pi's own `jiti`, uses the fixture payloads in `tests/fixtures` instead of the network, and sandboxes the agent dir in `/tmp`. It covers ratio math, tiers, per-call models, the `/v1/models` + `/api/pricing` join, config overrides, model definitions, snapshot round-trip, the provider refresh (against a stubbed `fetch`), the command handlers, and the picker/text view input handling.

## License

[MIT](LICENSE) © TolyanL
