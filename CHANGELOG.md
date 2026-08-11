# Changelog

## 0.1.0 — unreleased

Initial release.

- Registers `hetzner` as a pi provider against `https://inference.hetzner.com/api/v1` using
  `openai-completions`, with the four documented models at zero cost
- Auth through `/login hetzner` or `HETZNER_INFERENCE_API_KEY`; unconfigured is a hidden provider,
  not an error
- Model catalog discovery from `GET /v1/models`, id-only cache with a TTL, static fallback, and
  immediate re-registration when the catalog changes
- Rate-limit budget for the documented 60s / 10M input / 200k output per-key window: status line,
  80% warning, 429 explanation, and any rate-limit headers the API returns
- `/hetzner status|models|refresh|quiet|ask`
- Opt-in `hetzner_ask` tool for delegating bulk text work to a free model
- `scripts/probe.mjs` capability probe for the behaviour Hetzner does not document
