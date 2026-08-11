# pi-hetzner-inference — design

Why this package is shaped the way it is, and what was deliberately left out.
User-facing instructions are in [README.md](./README.md).

## Goal

Make the Hetzner Experiments Platform Inference API usable from pi as a **main agent model**, with
a **delegation tool** as a secondary use. Function calling was the open risk — Hetzner does not
document it — and `scripts/probe.mjs` confirmed on 2026-08-11 that `tools`, forced `tool_choice`
and tool-result replay all work, so the main-model path is the primary one and `hetzner_ask` stays
opt-in.

- Base URL `https://inference.hetzner.com/api/v1`, OpenAI-compatible, `Authorization: Bearer`
- Free during the experiment → `cost: 0` for every model
- Rate limits per API key: 60s window, 10M input / 200k output tokens, HTTP 429 on excess

## Why an extension rather than `models.json`

A static `models.json` provider works and is documented in the README as a fallback. The
extension earns its place on the parts that cannot be expressed statically:

| Capability | `models.json` | extension |
| --- | --- | --- |
| Four models, `cost: 0`, correct context windows | yes | yes |
| Catalog tracks `/v1/models` as the experiment changes | no | yes |
| Rate-limit budget visible before a turn stalls | no | yes |
| Actionable 429 message instead of a raw provider error | no | yes |
| `/hetzner status` reachability and auth diagnostics | no | yes |
| One-time experiment/telemetry notice | no | yes |
| Free model as delegated bulk worker (`hetzner_ask`) | no | yes |
| Versioned distribution via `pi install` | no | yes |

## What pi already does, so this package does not

Reading pi 0.83's actual implementation removed roughly half of the first draft:

- **API-key login.** `registerProvider(name, config)` is composed into a provider that already has
  an `api_key` auth method with a secret prompt, so `/login hetzner` works and the token lands in
  `~/.pi/agent/auth.json`. Resolution order is stored credential → configured `apiKey`
  (`$HETZNER_INFERENCE_API_KEY`) → unconfigured. No custom key file, no custom login command.
- **Unset env var is not an error.** The composed `check()` reports the provider as unconfigured
  when the referenced variable is missing, so models are hidden rather than blowing up at startup.
- **429 retry.** `pi-ai`'s `retryProviderRequest` retries 408/409/429/5xx and honours
  `retry-after` / `retry-after-ms` up to 60s. Hetzner's window is exactly 60s, so a server-provided
  delay is normally waited out automatically. Writing a `streamSimple` wrapper for backoff would
  duplicate that and cost the built-in streaming implementation. Dropped; the extension only
  explains what is happening.
- **Context-overflow recovery.** pi's overflow patterns already match the phrasing
  OpenAI-compatible servers produce (`Input length (X) exceeds model's maximum context length (Y)`),
  so no `message_end` rewriting is needed. The probe prints the real error text to confirm.
- **Streaming.** `api: "openai-completions"` uses pi's own implementation.

## Architecture

```
src/index.ts      extension factory: registration + event wiring
src/provider.ts   provider config, refreshModels, immediate re-registration
src/catalog.ts    static model table, compat flags, id → metadata merge
src/discovery.ts  GET /v1/models, id-only cache with TTL
src/budget.ts     60s sliding window, status formatting, rate-limit headers
src/commands.ts   /hetzner status|models|refresh|quiet|ask
src/delegate.ts   hetzner_ask tool (opt-in)
src/config.ts     env > config file > defaults
src/state.ts      per-process state
scripts/probe.mjs capability probe against the live API
```

No runtime dependencies: pi imports are type-only, `typebox` comes from pi. That keeps
`pi install` from pulling a second copy of pi as a peer.

### Startup cost is zero

The factory is synchronous and registers the cached-or-static catalog. Discovery happens later:
`refreshModels` when pi refreshes catalogs (`pi update models`), plus one opportunistic background
refresh on `session_start` that short-circuits on a fresh cache. Re-registration after the load
phase applies immediately, so a changed catalog needs no `/reload`.

### The catalog is two sources joined

`/v1/models` is authoritative about *which* models exist; `src/catalog.ts` is authoritative about
*what they are*, because the endpoint returns ids only. Hence:

- reported id ∩ known table → table metadata under the reported id (which may carry an org prefix)
- reported id ∉ table → registered with conservative defaults, flagged in `/hetzner models`
- known id ∉ report → retired, not registered
- empty or failed report → static table, so the provider is never left with zero models

The cache stores **only ids**. Metadata always comes from the installed package version, so
upgrading fixes a wrong context window immediately instead of waiting for a cache expiry.

### Compat flags follow the probe, not guesswork

Measured on 2026-08-11: function calling and forced `tool_choice` work, tool results replay,
streaming carries usage (`supportsUsageInStreaming: true`), no model returns `reasoning_content`
(`reasoning: false`), DeepSeek rejects image content while Qwen and Kimi accept base64 `data:`
URIs, and both `max_tokens` and `max_completion_tokens` are accepted. The rest
(`supportsDeveloperRole`, `supportsStore`, `supportsStrictMode`, `supportsOpenAIGrammarTools`) stay
`false`: they are OpenAI platform features that were not exercised, and `false` selects the
behaviour known to work. Users can flip individual models via `modelOverrides` without patching.

The probe also pinned the context windows from the server's own error text
(`max_model_len=max_total_tokens=512000` / `262144`), confirming the documented numbers.

### The advertised context window reserves output room

`max_model_len` caps input **plus** requested output: a request whose prompt alone fits is still
rejected when `input + max_tokens` exceeds it. Reporting the full figure as `contextWindow` would
leave a `maxTokens`-wide band where pi thinks a turn fits and the server disagrees. pi does recover
— its overflow patterns match this deployment's error text (verified with `--overflow`), so it
compacts and retries — but that costs a wasted round trip on a large session. So `contextWindow` is
`max_model_len - maxTokens`, and `maxTokens` is clamped to half of `max_model_len` to keep a
misconfiguration from erasing the input budget.

### Rate limits: visibility, not control

`turn_end` feeds assistant-message usage into a 60s sliding window (cached input counted as input,
which is the conservative reading), `hetzner_ask` feeds its own usage in, and
`after_provider_response` captures status and any `x-ratelimit-*` / `Retry-After` headers. Known
limitation, stated in the README: the window only sees traffic from this pi session, so it is a
lower bound on real key usage. If the API turns out to send its own rate-limit headers, those are
authoritative and shown in `/hetzner status`.

### Notice policy

The experiment/telemetry warning appears once per process, and only when a Hetzner model is
actually the active model (`session_start` or `model_select`). Installing the package while working
with another provider produces no noise. `/hetzner quiet` persists the opt-out.

## Testing

- `npm test` — `node:test`, no network: catalog merge (prefixed ids, unknown ids, retirement,
  dedup, ordering) and the rate window (expiry boundaries, worst-limit fraction, formatting,
  header parsing) with an injected clock
- `npm run typecheck` — `tsc --noEmit` against the real pi type definitions
- `pi -e ./src/index.ts --list-models` — verified: four models registered with a token present,
  hidden and error-free without one
- `npm run probe` — live capability matrix, see below

## Resolved by the probe

Function calling, streaming usage, base64 image input, real model ids (the documented table's
display names are the actual ids, only Qwen carries an org prefix) and the context windows are all
settled — see [Compat flags](#compat-flags-follow-the-probe-not-guesswork).

Context-overflow phrasing is settled too: the API answers with "This model's maximum context length
is 262144 tokens. However, you requested … for a total of at least …", which matches pi's overflow
patterns, so auto-compaction and retry work without a `message_end` normalizer.

## Open questions

1. **GLM-5.2-NVFP4 availability** — it did not answer a one-word prompt within 60s on 2026-08-11.
   Registered because the API lists it, flagged in `/hetzner models`, and untested for everything
   else. Re-run `node scripts/probe.mjs --model GLM-5.2-NVFP4 --timeout 300000`.
2. **Cache pricing** — `cacheRead`/`cacheWrite` are zero like everything else. If prompt caching
   ever appears, `cacheControlFormat` may become relevant.
3. **Publishing** — `repository`/`homepage` are unset in `package.json` and should point at the
   public repo before `npm publish`.
