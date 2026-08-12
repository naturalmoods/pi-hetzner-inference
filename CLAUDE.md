# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **pi extension** (npm package `pi-hetzner-inference`) that registers the Hetzner Experiments
Platform Inference API as a provider for the [pi coding agent](https://pi.dev). It ships no build
output: `package.json` declares `"pi": { "extensions": ["./src/index.ts"] }` and pi loads the
TypeScript sources directly. There are **no runtime dependencies** — every pi import is `import type`
only, and `typebox` (used in `src/delegate.ts`) is provided by pi at runtime. Keep it that way;
adding a runtime dep would make `pi install` pull a second copy of pi as a peer.

## Commands

```bash
npm install
npm run typecheck                              # tsc --noEmit against the real pi type defs
npm test                                       # node:test, no network
node --experimental-strip-types --test test/budget.test.ts   # one file
node --experimental-strip-types --test --test-name-pattern "worstFraction" test/budget.test.ts
pi -e ./src/index.ts                           # load the extension without installing
pi -e ./src/index.ts --list-models             # verify registration

HETZNER_INFERENCE_API_KEY=<token> npm run probe # live capability matrix
npm run probe -- --overflow                     # + a ~2MB request per model (verifies pi's compaction path)
npm run probe -- --model GLM-5.2-NVFP4 --timeout 300000
```

Releasing is a tag push: bump `version` in `package.json`, date the section in `CHANGELOG.md`, then
`git tag -a vX.Y.Z && git push origin vX.Y.Z`. `.github/workflows/release.yml` runs typecheck and
tests, refuses to continue if the tag and `package.json` disagree, publishes with `--provenance` over
OIDC (no npm token in secrets), and opens a GitHub Release from the matching changelog section. GLM
needs `--timeout 300000` when re-probing before a release; the default 60s is not enough for it.

Tests run TypeScript through `--experimental-strip-types`, so `.ts` extensions in imports are
mandatory (`allowImportingTsExtensions` + `verbatimModuleSyntax` are on). `tsconfig.json` sets
`strict` and `noUncheckedIndexedAccess`.

## Architecture

`src/index.ts` is the extension factory: **synchronous**, registers the provider, commands and the
optional tool, then wires pi events. Startup does no network I/O — that invariant is deliberate and
worth preserving.

| File | Role |
| --- | --- |
| `src/index.ts` | Factory + event handlers (`session_start`, `model_select`, `turn_end`, `after_provider_response`, `session_shutdown`) |
| `src/provider.ts` | `providerConfig()`, `refreshModels` hook, re-registration on catalog change |
| `src/catalog.ts` | Static model table, compat flags, id → metadata merge, rate-limit constants |
| `src/discovery.ts` | `GET /v1/models`, id-only cache with TTL, never throws |
| `src/budget.ts` | 60s sliding window, status formatting, rate-limit header parsing |
| `src/commands.ts` | `/hetzner status\|models\|refresh\|quiet\|ask` |
| `src/delegate.ts` | Opt-in `hetzner_ask` tool |
| `src/config.ts` | env > `~/.pi/agent/hetzner-inference.json` > defaults |
| `src/state.ts` | Per-process mutable state, threaded explicitly into every module |

### Two things drive nearly every design decision

**1. The catalog is two sources joined.** `GET /v1/models` returns *ids only*, so it is authoritative
about *which* models exist while `KNOWN_MODELS` in `src/catalog.ts` is authoritative about *what they
are* (context window, modalities, notes). `mergeCatalog()` implements the four cases: known id →
table metadata under the reported id; unknown id → conservative defaults plus a flag; documented id
absent from the report → retired; empty/failed report → static table, so the provider is never left
with zero models. The disk cache stores **only ids**, never metadata, so upgrading the package fixes
a wrong context window immediately instead of waiting for a cache expiry.

**2. Compat flags follow probe results, not guesswork.** `scripts/probe.mjs` measures what Hetzner
does not document (function calling, forced `tool_choice`, streaming usage, base64 image input,
rate-limit headers, overflow error phrasing). The load-bearing findings, all measured 2026-08-11:

- `maxTokensField: "max_tokens"` — GLM-5.2 **rejects** `max_completion_tokens`, the other three
  accept it. pi's default would break that model. The deployment is not uniform across models.
- `contextWindow = max_model_len - maxTokens`. `max_model_len` caps input *plus requested output*, so
  advertising the full figure leaves a `maxTokens`-wide band where pi thinks a turn fits and the
  server refuses it. `maxTokens` is also clamped to half of `max_model_len`.
- `MIN_MAX_TOKENS = 2048` — Qwen and GLM bill output tokens that never appear in the response (a
  one-word answer cost 232 / 101 tokens with `finish_reason: "stop"` and no `reasoning_content`). A
  small budget produced empty replies.
- `reasoning: false`, `supportsUsageInStreaming: true`, image input only on Qwen and Kimi. Remaining
  OpenAI-platform flags stay `false` because they were not exercised and `false` is the known-good
  path.

If you change a compat flag or a context window, re-run the probe and update the tables in both
`README.md` ("Measured behaviour") and `DESIGN.md` ("Compat flags") — they are the record of *why*
each value is what it is.

### What pi already does, so this package must not

Reimplementing any of these was explicitly rejected (see `DESIGN.md`):

- **API-key login.** The legacy `registerProvider(name, config)` form is composed by pi into a
  provider that already has an `api_key` auth method, `/login hetzner`, credential storage in
  `auth.json`, and fallback to `$HETZNER_INFERENCE_API_KEY`. No custom key file or login command.
- **Unconfigured is not an error.** A missing token leaves the provider registered but its models
  hidden. Nothing should throw at startup.
- **429 retry.** pi's `retryProviderRequest` already honours `Retry-After` up to 60s — exactly
  Hetzner's window. This package only *explains* 429s; wrapping `streamSimple` for backoff would
  duplicate that and cost the built-in streaming implementation.
- **Context-overflow recovery and streaming.** `api: "openai-completions"` uses pi's own
  implementation, and pi's overflow patterns already match this deployment's error text.

### Rate limits are visibility, not control

Documented limits are per API key over a 60s window: 10M input / 200k output. `turn_end` folds
assistant-message usage into `RateWindow` (cache reads/writes counted as input — the conservative
reading), `hetzner_ask` adds its own usage, and `after_provider_response` captures status and any
`x-ratelimit-*` headers. The window only sees this pi session, so it is a lower bound — that
limitation is stated in the README and should stay stated. If the API ever sends real rate-limit
headers, those are authoritative and shown in `/hetzner status`.

### Failure posture

Discovery, cache reads/writes and config reads all swallow their errors and degrade rather than
throw: a malformed config, an unwritable cache dir or an unreachable API must never break startup or
a turn. `src/config.ts` writes `~/.pi/agent/hetzner-inference.json` (mode `0600`) and it is the only
file this extension writes — **tokens never go there**, they live in pi's credential store.

## Testing

`npm test` is offline by construction: `test/catalog.test.ts` covers the merge (prefixed ids, unknown
ids, retirement, dedup, ordering) and `test/budget.test.ts` covers the rate window with an injected
clock (`usage(now)` takes the time; `RateWindow` never calls `Date.now()` itself — keep it that way).
Anything needing the network belongs in `scripts/probe.mjs`, not in the test suite.

## Docs to keep in sync

- `README.md` — user-facing: install, commands, model table, settings, measured behaviour
- `DESIGN.md` — rationale, the "why an extension rather than `models.json`" comparison, and **Open
  questions** (withheld output tokens, GLM latency variance, cache pricing, publishing metadata)
- `CHANGELOG.md` — 0.1.0 is still unreleased

`package.json` has no `repository`/`homepage` yet; they must be set before `npm publish`.
