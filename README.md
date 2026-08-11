# pi-hetzner-inference

Use the [Hetzner Experiments Platform Inference API](https://inference.hetzner.com) from
[pi](https://pi.dev) — free open-weight models, registered as a first-class pi provider.

- Four documented models registered with correct context windows and modalities, priced at `$0`
- Live catalog from `GET /v1/models`, cached, so a model Hetzner adds or removes shows up without a package update
- Per-key rate-limit budget in the status bar, and an explanation when a turn stalls on HTTP 429
- Optional `hetzner_ask` tool: hand bulk text work to a free model while an expensive model stays in the driver's seat

> **The service is an experiment, not a product.** No SLA, no guaranteed availability, and it
> can be changed or withdrawn at any time. Hetzner states it does not store request or response
> content, but usage telemetry is collected. Do not put production-critical work on it.

## Install

```bash
pi install npm:pi-hetzner-inference
```

Then authenticate, either interactively:

```
/login hetzner
```

or through the environment:

```bash
export HETZNER_INFERENCE_API_KEY=<your-token>
```

A stored credential (`/login`) wins over the environment variable. With neither, the provider
stays registered but its models are hidden from `/model` and `--list-models` — nothing errors.

## Use

```bash
pi --model hetzner/Kimi-K2.7-Code
```

or `/model hetzner/...` inside a session. Commands:

| Command | What it does |
| --- | --- |
| `/hetzner status` | Auth source, catalog origin and age, 60s rate-limit window, last 429, live reachability check |
| `/hetzner models` | Registered models with context window, modalities and architecture notes |
| `/hetzner refresh` | Re-read `/v1/models` now, ignoring the cache, and re-register the provider |
| `/hetzner quiet [on\|off]` | Silence the experiment notice |
| `/hetzner ask [on\|off]` | Enable or disable the `hetzner_ask` tool (needs `/reload`) |

## Models

| Model | Context | Modalities | Architecture |
| --- | --- | --- | --- |
| `Kimi-K2.7-Code` | 262k | text + image | MoE 1T total / 32B active, code-tuned |
| `GLM-5.2-NVFP4` | 512k | text | MoE 744B total / 40B active |
| `DeepSeek-V4-Flash-0731` | 512k | text | MoE 304B total / 13B active |
| `Qwen/Qwen3.6-35B-A3B-FP8` | 262k | text + image | MoE 35B total / 3B active |

`/v1/models` returns ids only, so the metadata above lives in `src/catalog.ts` and is overlaid
onto whatever the endpoint reports. An id this package does not recognise is still registered,
with conservative defaults (128k context, text only) and a note in `/hetzner models`.

## Rate limits

The documented limits are per API key, over a 60 second window: **10M input** and **200k output**
tokens. Exceeding either returns HTTP 429.

pi already retries 429 responses using the server's `Retry-After` (up to 60s), so this extension
does not retry anything. What it adds is visibility:

```
hetzner in 1.2M/10M · out 34k/200k (60s)
```

The status line counts token usage pi observed in this session, including anything spent by
`hetzner_ask`. Requests made with the same key from elsewhere are invisible to it. At 80% of
either limit you get a warning with the time until the window frees up; on a 429 you get a
notification saying pi is retrying and when. `/hetzner status` also reports any
`x-ratelimit-*` / `Retry-After` headers the API sends, which is the authoritative source when present.

## `hetzner_ask` (opt-in)

```
/hetzner ask on
/reload
```

Registers one tool. The main model can hand it self-contained text work — summarising a long log
or diff, translating, extracting fields — and it answers from a free Hetzner model. The delegate
gets no tools, no repository access and no conversation history, so everything it needs must be
in the call.

It is off by default: an extra tool in every system prompt is intrusive, and it is pointless when
the main model is already a Hetzner one.

## Settings

Environment variables win over `~/.pi/agent/hetzner-inference.json`, which wins over the defaults.
The config file is the only thing this extension writes — tokens live in pi's credential store.

| Setting | Env | Default | Meaning |
| --- | --- | --- | --- |
| `quiet` | `PI_HETZNER_QUIET` | `false` | Suppress the experiment notice |
| `discovery` | `PI_HETZNER_DISCOVERY` | `true` | Allow `/v1/models` lookups |
| `discoveryTtlHours` | `PI_HETZNER_DISCOVERY_TTL_HOURS` | `12` | Cache lifetime before a background refresh |
| `budget` | `PI_HETZNER_BUDGET` | `true` | Show the rate-limit status line |
| `ask` | `PI_HETZNER_ASK` | `false` | Register `hetzner_ask` |
| `askModel` | `PI_HETZNER_ASK_MODEL` | first available | Model id used by `hetzner_ask` |
| `maxTokens` | `PI_HETZNER_MAX_TOKENS` | `32768` | Output cap advertised for every model |

Discovery caches only the reported model ids, in `~/.pi/agent/cache/hetzner-inference-models.json`.
Metadata always comes from the current package version, so upgrading takes effect immediately
instead of being shadowed by a stale cache. Startup performs no network I/O: the cached (or static)
catalog is registered synchronously, and a refresh happens in the background only when the cache
is stale.

## Unverified behaviour

The Hetzner documentation covers models, chat completions and image input. It says nothing about
function calling, streaming usage, or base64 image input — all of which matter for a coding agent.
`scripts/probe.mjs` measures them:

```bash
HETZNER_INFERENCE_API_KEY=<token> npm run probe
```

It reports, per model: chat latency, whether `tools` / `tool_choice` are accepted and a tool call
is actually emitted, whether a tool-result round trip replays, streaming and `stream_options`
support, base64 `data:` image input, `max_completion_tokens` acceptance, `reasoning_content`
presence, and any rate-limit headers. The verdict section states plainly whether the models can
drive pi's agent loop or should be used through `hetzner_ask` instead.

Until measured, `src/catalog.ts` is deliberately conservative: `reasoning: false` everywhere, plus
compat flags that avoid OpenAI-only request fields (`system` instead of `developer`, `max_tokens`
instead of `max_completion_tokens`, no strict function schemas, no grammar tools).

To turn reasoning on for one model without patching the package, use `modelOverrides` in
`~/.pi/agent/models.json` — it applies to extension-registered models:

```json
{
  "providers": {
    "hetzner": {
      "modelOverrides": {
        "GLM-5.2-NVFP4": {
          "reasoning": true,
          "compat": { "thinkingFormat": "chat-template", "chatTemplateKwargs": { "thinking": { "$var": "thinking.enabled" } } }
        }
      }
    }
  }
}
```

## Without the extension

If all you want is the four models, `~/.pi/agent/models.json` is enough:

```json
{
  "providers": {
    "hetzner": {
      "baseUrl": "https://inference.hetzner.com/api/v1",
      "api": "openai-completions",
      "apiKey": "$HETZNER_INFERENCE_API_KEY",
      "compat": { "supportsDeveloperRole": false, "maxTokensField": "max_tokens" },
      "models": [
        { "id": "Kimi-K2.7-Code", "contextWindow": 262144, "input": ["text", "image"] },
        { "id": "GLM-5.2-NVFP4", "contextWindow": 512000 },
        { "id": "DeepSeek-V4-Flash-0731", "contextWindow": 512000 },
        { "id": "Qwen/Qwen3.6-35B-A3B-FP8", "contextWindow": 262144, "input": ["text", "image"] }
      ]
    }
  }
}
```

You lose catalog discovery, rate-limit visibility, the commands and `hetzner_ask`. Use whichever
fits; do not use both for the same provider id.

## Development

```bash
npm install
npm run typecheck
npm test                       # node:test, no network
pi -e ./src/index.ts           # load without installing
```

The extension has no runtime dependencies. All pi imports are type-only, and `typebox` is
provided by pi itself.

## License

MIT. The models are provided by their respective developers under their own licenses (MIT for
DeepSeek-V4-Flash and GLM-5.2, Modified MIT for Kimi-K2.7, Apache 2.0 for Qwen3.6) and come with
no warranty of any kind.
