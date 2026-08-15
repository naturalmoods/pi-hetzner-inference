# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

All repository artifacts and collaboration text must be English, including code, comments, documentation,
commits, branches, issues, pull requests, reviews, and release notes.

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

HETZNER_INFERENCE_API_KEY=<token> npm run probe -- --strict --timeout 300000 # live release gate
npm run probe -- --strict --overflow --timeout 300000 # + ~2MB/model, requires compaction checks
npm run probe -- --model GLM-5.2-NVFP4 --timeout 300000 # diagnostic subset, not a release gate
```

`.github/workflows/ci.yml` runs typecheck and tests on Node 22 and 24 for every push and pull request
— 22 is the oldest line whose `--experimental-strip-types` the tests rely on, and `engines.node`
declares that floor (`>=22.6`, where the feature landed), so keep both in step. The probe is
deliberately absent from CI: it needs a live token and the rate limits are per key.

Releasing is a tag push, and never a manual `npm publish` — the account's 2FA is `auth-and-writes`, so
publishing by hand needs an OTP at a real terminal and produces a tarball with no provenance (0.1.0 is
the one such version). The sequence:

1. `npm run probe -- --strict --timeout 300000 --json .probe-release.json` with the token exported.
   Every known model and load-bearing check must pass; use `--overflow` when re-validating compaction
2. bump `version` in `package.json`, then `npm install --package-lock-only` so the lockfile follows
3. replace `## Unreleased` in `CHANGELOG.md` with `## X.Y.Z — YYYY-MM-DD` — the workflow lifts the
   release notes from that exact version section
4. commit, push, wait for green CI
5. `git tag -a vX.Y.Z -m "X.Y.Z" && git push origin vX.Y.Z` — **both halves**; a tag that exists only
   locally triggers nothing, which has happened
6. verify: `gh run view` for the steps, then `npm install pi-hetzner-inference@X.Y.Z` in a scratch dir
   and `npm audit signatures`, which must report a verified attestation

`.github/workflows/release.yml` validates the exact tag, its commit, default-branch ancestry, and
`package.json` version before separate check, npm publish, and GitHub Release jobs. Only the publish
job receives OIDC; only the final job receives repository write access. Actions and npm are pinned.
For a retry without moving the tag, dispatch against the tag ref, not the default branch:
`gh workflow run release.yml --ref vX.Y.Z -f tag=vX.Y.Z`. Protected `v*` tags may be created only by
the repository maintainer.

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
| `src/provider.ts` | `providerConfig()`, transactional `refreshModels` publication |
| `src/catalog.ts` | Static model table, compat flags, id → metadata merge, rate-limit constants |
| `src/discovery.ts` | `GET /v1/models`, bounded id-only cache with TTL, graceful fallback |
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
absent from the report → retired; empty successful report → static table, so the provider is never
left with zero models; failed, cancelled, or superseded refresh → preserve the current last-known-good
catalog. The disk cache stores **only ids**, never metadata, so upgrading the package fixes
a wrong context window immediately instead of waiting for a cache expiry.

**2. Compat flags follow probe results, not guesswork.** `scripts/probe.mjs` measures what Hetzner
does not document (function calling, forced `tool_choice`, streaming usage, base64 image input,
rate-limit headers, overflow error phrasing). The load-bearing findings, all measured 2026-08-11:

- `maxTokensField: "max_tokens"` — GLM-5.2 rejected `max_completion_tokens` on one run and accepted
  it later the same day. `max_tokens` remained stable across all four, so URL-based guessing is unsafe.
- `contextWindow = max_model_len - maxTokens`. `max_model_len` caps input *plus requested output*, so
  advertising the full figure leaves a `maxTokens`-wide band where pi thinks a turn fits and the
  server refuses it. `maxTokens` is also clamped to half of `max_model_len`.
- `MIN_MAX_TOKENS = 2048` — all four return thinking under `reasoning` and bill it as output. A
  small budget can be exhausted by thinking before any visible reply or tool call appears.
- `reasoning: true` with a measured per-model thinking switch, `supportsUsageInStreaming: true`,
  image input only on Qwen and Kimi. Remaining OpenAI-platform flags stay `false` because they were
  not exercised and `false` is the known-good path.

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

Discovery, cache reads/writes and config reads swallow ordinary errors and degrade rather than
throw; caller cancellation is the exception and must propagate without replacing last-known state.
A malformed config, an unwritable cache dir or an unreachable API must never break startup or a turn.
The extension writes settings to `~/.pi/agent/hetzner-inference.json` and discovered model ids to
`~/.pi/agent/cache/hetzner-inference-models.json`, both mode `0600`. **Tokens never go there**; they
live in pi's credential store.

## Testing

`npm test` is offline by construction and covers catalog, config, discovery, delegation, event/provider
wiring, strict-probe verdicts, and the rate window. CI also loads `src/index.ts` through the lockfile's
real pi package with a fresh config directory, no credential, discovery disabled, and `PI_OFFLINE=1`.
Anything needing the network belongs in `scripts/probe.mjs`, not in the test suite or CI.

## Docs to keep in sync

- `README.md` — user-facing: install, commands, model table, settings, measured behaviour
- `DESIGN.md` — rationale, the `models.json` comparison, measured compat decisions, and open questions
- `CHANGELOG.md` — released versions and upcoming changes
