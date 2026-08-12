# Changelog

## Unreleased

- Declare `engines.node: ">=22.6"`. That is where Node's type stripping landed, which is what lets pi
  load this package's TypeScript sources directly; below it the failure was silent

## 0.1.0 — 2026-08-12

Initial release.

- Registers `hetzner` as a pi provider against `https://inference.hetzner.com/api/v1` using
  `openai-completions`, with the four documented models at zero cost
- Auth through `/login hetzner` or `HETZNER_INFERENCE_API_KEY`; unconfigured is a hidden provider,
  not an error
- Model catalog discovery from `GET /v1/models`, id-only cache with a TTL, static fallback, and
  immediate re-registration when the catalog changes
- Thinking support: the deployment returns reasoning under `reasoning` (not `reasoning_content`), so
  all four models ship with `reasoning: true` and the `chat_template_kwargs` key measured for each —
  `thinking` for Kimi, DeepSeek and GLM, `enable_thinking` for Qwen — which makes `think:off` actually
  stop the reasoning instead of only hiding it
- Rate-limit budget for the documented 60s / 10M input / 200k output per-key window: status line,
  80% warning, 429 explanation, and any rate-limit headers the API returns
- `/hetzner status|models|refresh|quiet|ask`
- Opt-in `hetzner_ask` tool for delegating bulk text work to a free model, with thinking switched off
  so the delegate does not bill reasoning it discards
- `scripts/probe.mjs` capability probe for the behaviour Hetzner does not document
