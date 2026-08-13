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

The one exception is `--model hetzner/...` on the command line: pi resolves that model at startup,
so without a token it fails with *No API key found for hetzner*. Authenticate first (start pi
without `--model`, run `/login hetzner`), or export the variable before launching.

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

| Model | Total tokens | Modalities | Agent loop | Thinking | Architecture |
| --- | --- | --- | --- | --- | --- |
| `Kimi-K2.7-Code` | 262k | text + image | yes | on, switchable | MoE 1T total / 32B active, code-tuned |
| `DeepSeek-V4-Flash-0731` | 512k | text | yes | on, switchable | MoE 304B total / 13B active |
| `Qwen/Qwen3.6-35B-A3B-FP8` | 262k | text + image | yes | on, switchable | MoE 35B total / 3B active |
| `GLM-5.2-NVFP4` | 512k | text | yes | on, switchable | MoE 744B total / 40B active |

**All four think before answering**, and the deployment returns that thinking on a separate
`reasoning` channel, so pi shows it as a collapsible block rather than mixing it into the answer.
Thinking is billed as output either way, and `think:off` genuinely stops it on every model — each
one's switch was measured rather than assumed.

Thinking is also why `maxTokens` should not be set low on Qwen in particular: it reasons at length
(around 230 output tokens to answer a one-word question), and with only 256 tokens of budget it never
reached the tool call at all — it stopped at `finish_reason: "length"` mid-thought. With room it calls
tools reliably. If a model looks incapable of tool use, check the finish reason before believing it.

The token figure is the server's `max_model_len`, and it caps **input plus requested output together**:
a 262k-token prompt is rejected if `max_tokens` is 16. So the context window pi is told about is
`max_model_len - maxTokens` (229k input + 32k output for Kimi, by default). Without that reservation
pi would consider a turn to fit that the server then refuses — recoverable, but a wasted round trip.
Lower `maxTokens` if you would rather trade output room for input room.

**Latency is uneven.** GLM-5.2-NVFP4 answered a one-word prompt in 2.3 seconds on one run, took 45
seconds on another, and exceeded 60 seconds on two more. Expect that from an experimental platform,
and re-check any model with `node scripts/probe.mjs --model <id> --timeout 300000`.

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
notification saying pi is retrying and when.

The API sent no `x-ratelimit-*` headers when probed, so the local window is the only signal
available. If that changes, those headers are authoritative and `/hetzner status` shows them.

## `hetzner_ask` (opt-in)

```
/hetzner ask on
/reload
```

Registers one sequential tool. The main model can hand it self-contained text work — summarising
a long log or diff, translating, extracting fields — and it answers from a registered Hetzner model.
The delegate gets no tools, no repository access and no conversation history, so everything it needs
must be in the call. `task` is limited to 4,000 characters, `input` to 1,000,000 characters, and an
optional model id to 200 characters. Input is marked as untrusted data, and returned text is marked as
untrusted rather than authority for consequential tool actions.

Thinking is switched off for the delegate. This work is mechanical, and reasoning is billed against
the same per-key output budget the main model is spending — so paying for a reasoning block that is
then discarded is waste. Models with no measured switch are left alone rather than sent a guessed
key, and `/hetzner ask` reports which case applied in the tool result.

It is off by default: an extra tool in every system prompt is intrusive, and it is pointless when
the main model is already a Hetzner one.

## Settings

Environment variables win over `~/.pi/agent/hetzner-inference.json`, which wins over the defaults.
The extension writes that settings file and the model-id cache described below, both with mode `0600`.
API tokens live only in pi's credential store.

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
Responses are limited to 1 MB and 1,000 models; ids are limited to 200 printable URL-safe characters.
Metadata always comes from the current package version, so upgrading takes effect immediately
instead of being shadowed by a stale cache. With discovery disabled, the cache is ignored. Startup
performs no network I/O: the static catalog is registered synchronously, and an opportunistic refresh
runs without blocking session startup. Expected skips (disabled, offline, no token, or a fresh cache)
are reported separately from transport, authentication, and response-shape failures.

## Measured behaviour

The Hetzner documentation covers models, chat completions and image input, but says nothing about
function calling, streaming usage or base64 image input — all of which decide whether a coding
agent can use the service at all. `scripts/probe.mjs` measures them:

```bash
HETZNER_INFERENCE_API_KEY=<token> npm run probe
npm run probe -- --overflow          # also verifies pi's auto-compaction path (~2MB per model)
```

Results from 2026-08-11:

| Capability | Result |
| --- | --- |
| `tools` accepted, tool call emitted | yes — all four |
| Forced `tool_choice` | yes |
| Tool-result round trip | yes |
| Streaming | yes, with usage in the stream |
| Base64 `data:` image input | Qwen and Kimi yes; DeepSeek and GLM reject it as "not a multimodal model" |
| Separate thinking channel | `reasoning` on all four — **not** `reasoning_content` |
| Switching thinking off | `chat_template_kwargs.thinking` on Kimi, DeepSeek and GLM; `.enable_thinking` on Qwen and GLM |
| `reasoning_effort` | accepted, but pi never sends it under `thinkingFormat: "chat-template"` |
| `max_completion_tokens` | GLM rejected it on one run and accepted it on a later one — so this package pins `max_tokens` |
| Rate-limit response headers | none sent |
| Context-overflow error | matches pi's overflow patterns, so pi auto-compacts and retries |
| Trivial prompt latency | 0.8–3.4s, with 30s, 45s and >60s outliers on GLM |

GLM-5.2-NVFP4 needs a longer deadline than the probe's default to be measured at all
(`npm run probe -- --model GLM-5.2-NVFP4 --timeout 300000`); it answered a one-word prompt in 29.8s on
the run that produced its rows above.

Three consequences worth knowing:

**`max_completion_tokens` support moves under you.** GLM-5.2-NVFP4 rejected that field outright on
one probe run and accepted it on a later one the same day. `max_tokens` has been accepted by every
model on every run, and the server phrases its own errors in terms of it, so
`maxTokensField: "max_tokens"` is pinned rather than left to pi's URL-based auto-detection. Treat
every capability here as a property of today's deployment, not a guarantee.

**The thinking channel is `reasoning`, not `reasoning_content`.** Every model bills output tokens for
thinking a one-word reply — around 230 on Qwen, 91 on GLM, 26 on DeepSeek, 17 on Kimi — and that text
comes back under `reasoning`. pi reads `reasoning_content`, `reasoning` and `reasoning_text` in that
order and renders whichever it finds, so the thinking is displayed, not lost. Two things follow: the
`maxTokens` floor of 2048 stays (on a 32-token budget thinking consumed the whole budget and the
visible reply came back empty), and `reasoning: true` plus the measured `thinkingFormat` is what makes
`think:off` actually stop the reasoning instead of merely hiding it.

**The thinking switch differs per model.** Qwen answers to `chat_template_kwargs.enable_thinking`,
Kimi and DeepSeek to `chat_template_kwargs.thinking`, GLM to either — and where a model does not
recognise a key it still returns HTTP 200 and ignores it. Accepting a parameter proves nothing here;
only the reasoning channel going quiet does. That is why `src/catalog.ts` carries one measured key per
model rather than a shared default.

So `src/catalog.ts` sets `supportsUsageInStreaming: true`, `reasoning: true` with the per-model
thinking switch on all four, image input only on Qwen and Kimi, and keeps the remaining
OpenAI-platform compat flags off (`system` instead of `developer`, `max_tokens`, no strict function
schemas, no grammar tools) because those were not exercised and `false` is the behaviour that is known
to work.

To override any of this without patching the package, use `modelOverrides` in
`~/.pi/agent/models.json` — it applies to extension-registered models. For example, to pin a model to
the other thinking switch, or to turn reasoning off for one entirely:

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
