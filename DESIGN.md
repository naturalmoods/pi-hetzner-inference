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
| One-time experiment/metrics-and-retention notice | no | yes |
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
src/provider.ts   provider config and transactional refreshModels publication
src/catalog.ts    static model table, compat flags, id → metadata merge
src/discovery.ts  GET /v1/models, id-only cache with TTL
src/budget.ts     60s sliding window, status formatting, rate-limit headers
src/commands.ts   /hetzner status|models|refresh|quiet|ask
src/delegate.ts   hetzner_ask tool (opt-in)
src/config.ts     env > config file > defaults
src/state.ts      per-process state
scripts/probe.mjs live capability probe and strict release gate
```

No runtime dependencies: pi imports are type-only, `typebox` comes from pi. That keeps
`pi install` from pulling a second copy of pi as a peer.

### Startup cost is zero

The factory is synchronous and registers the static catalog without network I/O. Discovery happens
later: `refreshModels` when pi refreshes catalogs (`pi update models`), plus one opportunistic
background refresh on `session_start` that short-circuits on a fresh cache. A changed catalog is
published without blocking session startup and needs no `/reload`; shutdown and superseded refreshes
cannot replace the last-known-good catalog.

### The catalog is two sources joined

`/v1/models` is authoritative about *which* models exist; `src/catalog.ts` is authoritative about
*what they are*, because the endpoint returns ids only. Hence:

- reported id ∩ known table → table metadata under the reported id (which may carry an org prefix)
- reported id ∉ table → registered with conservative defaults, flagged in `/hetzner models`
- known id ∉ report → retired, not registered
- empty successful report → static table, so the provider is never left with zero models
- failed, cancelled, or superseded refresh → retain the current last-known-good catalog

The cache stores **only ids**. Metadata always comes from the installed package version, so
upgrading fixes a wrong context window immediately instead of waiting for a cache expiry.

### Compat flags follow the probe, not guesswork

Measured on 2026-08-11: function calling and forced `tool_choice` work, tool results replay, streaming
carries usage (`supportsUsageInStreaming: true`), and DeepSeek and GLM reject image content while Qwen
and Kimi accept base64 `data:` URIs. The rest
(`supportsDeveloperRole`, `supportsStore`, `supportsStrictMode`, `supportsOpenAIGrammarTools`) stay
`false`: they are OpenAI platform features that were not exercised, and `false` selects the behaviour
known to work. Users can flip individual models via `modelOverrides` without patching.

The first probe reported "no reasoning" for this deployment, and that was a **bug in the probe**: it
checked `reasoning_content` only, while pi reads `reasoning_content`, `reasoning` and `reasoning_text`
in that order (`reasoningFields` in pi-ai's `api/openai-completions.js`). Hetzner uses the second.
Every model that answered returns a populated `reasoning` field, which also explains the output tokens
that the first probe wrote up as billed-but-withheld — they were neither hidden nor lost, just looked
for under the wrong name. Two lessons are now built into `scripts/probe.mjs`: enumerate the raw
message keys rather than testing one guess, and mirror pi's own field precedence instead of a single
convention.

### The thinking switch is per model, and acceptance is not confirmation

`reasoning: true` alone would let pi *display* thinking it cannot control. What makes `think:off`
work is `thinkingFormat: "chat-template"` plus a `chat_template_kwargs` key, and the key is not
uniform: Qwen wants `enable_thinking`, Kimi and DeepSeek want `thinking`. Each model returns HTTP 200
for the other's key and ignores it, so the probe asserts on the *effect* — did the `reasoning` field
go empty — rather than on the status code. A shared default would have produced a `think:off` that
silently does nothing on two of the three models.

Consequently `reasoning` and the thinking key live on `ModelSpec`, and `compatFor()` merges them over
the shared `COMPAT`. GLM accepts either key — it was the last to be measured, since it needs a deadline
well past the probe's 60s default — and takes `thinking` for consistency with Kimi and DeepSeek. A
model whose switch has *not* been measured, including any id the endpoint reports that this table does
not know, keeps `reasoning: false`: the failure mode of guessing is a control that appears to work and
doesn't, which is worse than pi's display-only behaviour. A test asserts that every documented model
has a measured switch, so adding one to the table without probing it fails the suite.

`hetzner_ask` needs the same rule for a different reason — it always wants thinking off, since it
summarises and extracts and then throws the reasoning away — so the "measured key or nothing" decision
lives once, in `thinkingOffKwargs()`, and both callers read it. Duplicating the key list in the
delegate would eventually let the two disagree, and the failure would be invisible: the request would
still return HTTP 200.

One consequence of choosing `chat-template`: pi's thinking parameters are a single if/else chain, and
the `chat-template` branch precedes the `reasoning_effort` branch, so `supportsReasoningEffort` is
never consulted for these models. The probe confirmed `reasoning_effort` is accepted, but pi has no
occasion to send it, so the flag stays unset rather than asserting a behaviour that never runs.

`maxTokensField: "max_tokens"` is pinned because the alternative is not stable here: GLM-5.2 rejected
`max_completion_tokens` on one run and accepted it on a later one the same day. `max_tokens` has worked
on every model on every run and the server phrases its own errors in terms of it. A capability that
changes within a day is the strongest argument for tying every compat decision to a probe result — and
for re-running the probe rather than trusting a table written last week.

The probe also pinned the context windows from the server's own error text
(`max_model_len=max_total_tokens=512000` / `262144`), confirming the documented numbers. Its
maintainer-run `--strict` mode now turns those observations into an explicit release gate: every
known model must pass tools, forced tool choice, tool replay, streaming usage, measured image
modality, thinking control, `max_tokens`, and context-ceiling checks. Timeouts and incomplete results
are inconclusive and fail the gate; overflow is explicitly skipped unless `--overflow` requests it.
The JSON report carries the measurement timestamp and every check's verdict. This stays outside CI
because it needs a live credential and consumes the same per-key rate budget as users.

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

The experiment/metrics warning appears once per process, and only when a Hetzner model is actually
the active model (`session_start` or `model_select`). Installing the package while working with
another provider produces no noise. `/hetzner quiet` persists the opt-out. Hetzner's public
[Experiments Platform documentation](https://docs.hetzner.com/general/company-and-policy/experiments/experiments-platform/)
describes metric collection but does not specify prompt, completion, or image retention, so the
notice does not claim that request or response content is never stored.

## Testing

- `npm test` — `node:test`, no network: catalog/config/discovery boundaries, delegation limits,
  provider and event wiring, the per-model thinking switches, strict-probe verdict calculation, and
  the rate window with an injected clock
- `npm run typecheck` — `tsc --noEmit` against the real pi type definitions
- `pi -e ./src/index.ts --list-models` — verified: four models registered with a token present,
  hidden and error-free without one
- `npm run probe -- --strict --timeout 300000` — live release gate, see below
- `.github/workflows/ci.yml` — typecheck, tests, and a real pi host-load smoke check without network
  or credentials on Node 22 and 24 for every push and pull request
- `.github/workflows/release.yml` — validates the exact protected tag and default-branch ancestry,
  checks both Node lines without elevated credentials, then gives OIDC only to the npm publish job
  and repository write access only to GitHub Release creation. Actions and npm are immutable-pinned;
  an existing package is accepted only when its SLSA provenance references the expected commit.
  0.1.0 remains the sole hand-published release without provenance

## Resolved by the probe

Function calling, streaming usage, base64 image input, the `reasoning` thinking channel and its
per-model switch, real model ids (the documented table's display names are the actual ids, only Qwen
carries an org prefix) and the context windows are all settled — see
[Compat flags](#compat-flags-follow-the-probe-not-guesswork).

A measurement lesson worth keeping: Qwen appeared to be incapable of tool calls until the probe's
budget went from 256 to 1024 tokens. It reasons before answering, reasoning is billed against
`max_tokens`, and a budget that only fits the tool call itself ends the response at
`finish_reason: "length"` mid-thought with no `tool_calls` emitted. Every capability check on a
reasoning model needs headroom for the thinking plus the artefact being measured, and needs to report
the finish reason so starvation is distinguishable from incapacity.

Context-overflow phrasing is settled too: the API answers with "This model's maximum context length
is 262144 tokens. However, you requested … for a total of at least …", which matches pi's overflow
patterns, so auto-compaction and retry work without a `message_end` normalizer.

## Open questions

1. **Latency variance** — GLM-5.2-NVFP4 took 2.3s, 29.8s, 45s and twice over 60s on the same one-word
   prompt across five runs. Nothing to fix in the extension; noted in `/hetzner models` so a stalled
   turn is not mistaken for a bug. It is a weak choice for interactive work, and probing it needs
   `--timeout 300000`.
2. **Cache pricing** — `cacheRead`/`cacheWrite` are zero like everything else. If prompt caching
   ever appears, `cacheControlFormat` may become relevant.
3. **`hetzner_ask` has never run with the thinking switch live** — the probe measured the request shape
   (sending the model's measured `chat_template_kwargs` key empties the `reasoning` field), and a unit
   test pins which key each model gets, but no delegated call has been made through the tool itself
   since. To check: `/hetzner ask on`, `/reload`, then a summarising call — the tool result carries
   `details.usage.output` and `details.thinking`, and the output count should be far lower than it was
   when the delegate was still paying for reasoning.
4. **0.1.0 has no provenance** — it was published by hand before the release workflow existed, so it is
   the one version whose tarball cannot be tied back to a commit. Nothing to fix: republishing under the
   same version is impossible by design, and 0.1.1 supersedes it. Worth knowing only if someone audits
   the older release and finds the attestation missing.
