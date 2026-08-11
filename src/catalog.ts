/**
 * Static model catalog for the Hetzner Inference API.
 *
 * `/v1/models` only returns model ids, so context window, modalities and
 * compat quirks live here and are overlaid onto whatever the endpoint reports.
 * Ids that are not in this table still get registered with conservative
 * defaults, so a model added by Hetzner is usable before this package is updated.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const PROVIDER_ID = "hetzner";
export const PROVIDER_NAME = "Hetzner Inference (experimental)";
export const BASE_URL = "https://inference.hetzner.com/api/v1";

/** Environment variable pi resolves the API token from, next to `/login hetzner`. */
export const API_KEY_ENV = "HETZNER_INFERENCE_API_KEY";

/** Per-key rate limits documented for the experiment. */
export const RATE_LIMITS = {
	windowMs: 60_000,
	inputTokens: 10_000_000,
	outputTokens: 200_000,
} as const;

/** Free while the experiment lasts. Explicit zeros keep pi's cost UI honest. */
const FREE: ProviderModelConfig["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Compat flags for this deployment.
 *
 * Measured with `scripts/probe.mjs` on 2026-08-11 (see README):
 * - Function calling works on Kimi and DeepSeek: `tools`, forced `tool_choice`,
 *   and tool-result replay all behave, so they can drive pi's agent loop.
 * - Streaming returns usage, hence `supportsUsageInStreaming`.
 * - Thinking arrives on a separate channel — see `ModelSpec.reasoning` below.
 *
 * `maxTokensField: "max_tokens"` is pinned because the alternative is not stable
 * here. GLM-5.2-NVFP4 rejected `max_completion_tokens` on one probe run and
 * accepted it on a later one the same day, so support for that field moves under
 * us — this is an experiment, and the deployment is not uniform across models or
 * over time. `max_tokens` has been accepted by every model on every run, and the
 * server's own errors are phrased in terms of it, so pinning it is safer than
 * letting pi's URL-based auto-detection choose a field whose support comes and
 * goes.
 *
 * The remaining flags stay off because they are OpenAI platform features that
 * were not verified here; `false` falls back to behaviour that is known to work.
 */
const COMPAT: ProviderModelConfig["compat"] = {
	supportsDeveloperRole: false,
	supportsStore: false,
	supportsStrictMode: false,
	supportsOpenAIGrammarTools: false,
	supportsUsageInStreaming: true,
	maxTokensField: "max_tokens",
};

/** Default output cap. One response stays well inside the 200k/60s output budget. */
export const DEFAULT_MAX_TOKENS = 32_768;

/**
 * Floor for the output cap.
 *
 * These models think before answering and bill for it: a one-word answer cost
 * 220 output tokens on Qwen and 17 on Kimi, with `finish_reason: "stop"` and only
 * the answer in `content`. The thinking is not lost — it arrives on the separate
 * `reasoning` channel (see `THINKING_KWARG`) — but it is charged against the same
 * `max_tokens` budget, and on a 32-token budget it consumed everything and the
 * visible reply came back empty. A floor keeps a small `maxTokens` setting from
 * producing silent non-answers.
 */
export const MIN_MAX_TOKENS = 2_048;

/** Defaults for a model id this package does not know yet. */
export const UNKNOWN_MODEL_DEFAULTS = {
	totalTokens: 128_000,
	input: ["text"] as ("text" | "image")[],
};

export interface ModelSpec {
	/** Documented id, used when `/v1/models` cannot be reached. */
	id: string;
	/** Display name. Keeps the provider visible in model pickers. */
	name: string;
	/** Matches the reported id, which may carry an org prefix or a version suffix. */
	match: RegExp;
	/**
	 * The server's `max_model_len`, which caps input *plus* requested output.
	 * `contextWindow` is derived from it — see `toModelConfig`.
	 */
	totalTokens: number;
	input: ("text" | "image")[];
	/**
	 * Whether the server returns thinking on a separate channel for this model.
	 *
	 * All of these reason unprompted, and the deployment returns it in the
	 * `reasoning` field — *not* `reasoning_content`. pi reads `reasoning_content`,
	 * `reasoning` and `reasoning_text` in that order and renders whichever it
	 * finds as a thinking block, and it does so regardless of this flag. What the
	 * flag buys is the *request* side: only with `reasoning: true` does pi apply
	 * `thinkingFormat`, which is what makes `think:off` able to switch the
	 * reasoning off instead of merely displaying it.
	 *
	 * False here means "not measured", not "does not reason" — see GLM below.
	 */
	reasoning: boolean;
	/**
	 * `chat_template_kwargs` key that silences the reasoning channel, measured.
	 *
	 * The key is not uniform across this deployment: Qwen answers to
	 * `enable_thinking`, Kimi and DeepSeek to `thinking`, and each ignores the
	 * other's key while still returning HTTP 200 — an unknown kwarg is dropped
	 * silently, so "accepted" proves nothing and only the reasoning going quiet
	 * does. Hence one measured key per model rather than a shared guess.
	 */
	thinkingKwarg?: string;
	/** Shown by `/hetzner models`. */
	note: string;
}

/**
 * Documented catalog as of 2026-08. Order drives the display order.
 *
 * Context windows are confirmed by the API itself: an over-large `max_tokens`
 * request reports `max_model_len=max_total_tokens=512000` for DeepSeek and
 * `262144` for Qwen and Kimi. Note that this is a *total* budget shared between
 * input and output, which is why `maxTokens` stays well below it.
 *
 * Modalities are probe results, not guesses: DeepSeek and GLM reject image content
 * with "is not a multimodal model", while Qwen and Kimi accept base64 `data:` URIs.
 */
export const KNOWN_MODELS: readonly ModelSpec[] = [
	{
		id: "Kimi-K2.7-Code",
		name: "Kimi K2.7 Code (Hetzner)",
		match: /kimi-k2(\.7)?-code/i,
		totalTokens: 262_144,
		input: ["text", "image"],
		reasoning: true,
		thinkingKwarg: "thinking",
		note: "MoE 1T total / 32B active, code-tuned; fastest to first token in probing; reasons briefly (~17 tokens on a one-word answer)",
	},
	{
		id: "GLM-5.2-NVFP4",
		name: "GLM 5.2 (Hetzner)",
		match: /glm-5(\.2)?/i,
		totalTokens: 512_000,
		input: ["text"],
		reasoning: true,
		// The only model that accepts *either* key: `thinking` and `enable_thinking`
		// both silenced it. `thinking` is used for consistency with Kimi and
		// DeepSeek, and because it is the one this model shares with them.
		thinkingKwarg: "thinking",
		note: "MoE 744B total / 40B active, text only; latency is the worst of the four — 2.3s to 45s to >60s on a one-word prompt",
	},
	{
		id: "DeepSeek-V4-Flash-0731",
		name: "DeepSeek V4 Flash (Hetzner)",
		match: /deepseek-v4-flash/i,
		totalTokens: 512_000,
		input: ["text"],
		reasoning: true,
		thinkingKwarg: "thinking",
		note: "MoE 304B total / 13B active, text only",
	},
	{
		id: "Qwen/Qwen3.6-35B-A3B-FP8",
		name: "Qwen3.6 35B A3B (Hetzner)",
		match: /qwen3(\.6)?-35b-a3b/i,
		totalTokens: 262_144,
		input: ["text", "image"],
		reasoning: true,
		// The only model that wants `enable_thinking` rather than `thinking`.
		thinkingKwarg: "enable_thinking",
		note: "MoE 35B total / 3B active; reasons at length (~230 output tokens for a one-word answer), so give it output room",
	},
];

export interface CatalogOptions {
	maxTokens?: number;
}

/**
 * Advertise the *input* budget as the context window.
 *
 * `max_model_len` caps input plus requested output together — the API rejects a
 * request when `input + max_tokens` exceeds it, even if the input alone fits:
 *
 *   "This model's maximum context length is 262144 tokens. However, you requested
 *    16 output tokens and your prompt contains at least 262129 input tokens, for
 *    a total of at least 262145 tokens."
 *
 * Reporting the full `max_model_len` would leave a `maxTokens`-wide band where pi
 * believes a turn fits but the server refuses it. pi recovers (it recognises that
 * error and compacts, then retries), but the user pays for a wasted round trip.
 * Reserving the output room up front makes pi's own accounting match reality, so
 * threshold compaction happens before a request can fail.
 */
/**
 * Per-model thinking control on top of the shared compat flags.
 *
 * `thinkingFormat: "chat-template"` makes pi send `chat_template_kwargs` with the
 * measured key, and `{ $var: "thinking.enabled" }` resolves to whether the user
 * has thinking on — so `think:off` sends `false` and the reasoning channel goes
 * quiet, which is exactly what the probe verified.
 *
 * Note that this format also *replaces* `reasoning_effort`: pi picks one branch of
 * a single if/else chain, and the `chat-template` branch precedes the
 * `reasoning_effort` one, so `supportsReasoningEffort` is never consulted for
 * these models. The probe did confirm the parameter is accepted, but pi has no
 * occasion to send it, so the flag stays unset rather than asserting something
 * that never takes effect.
 */
function compatFor(spec: ModelSpec | undefined): ProviderModelConfig["compat"] {
	if (!spec?.reasoning || !spec.thinkingKwarg) return COMPAT;
	return {
		...COMPAT,
		thinkingFormat: "chat-template",
		chatTemplateKwargs: { [spec.thinkingKwarg]: { $var: "thinking.enabled" } },
	};
}

function toModelConfig(
	id: string,
	spec: ModelSpec | undefined,
	options: CatalogOptions,
): ProviderModelConfig {
	const totalTokens = spec?.totalTokens ?? UNKNOWN_MODEL_DEFAULTS.totalTokens;
	const maxTokens = Math.min(
		Math.max(options.maxTokens ?? DEFAULT_MAX_TOKENS, MIN_MAX_TOKENS),
		Math.floor(totalTokens / 2),
	);
	return {
		id,
		name: spec?.name ?? `${id} (Hetzner)`,
		// An unknown model gets `false`: pi still displays any reasoning it returns,
		// but no unverified thinking switch is sent on its behalf.
		reasoning: spec?.reasoning ?? false,
		input: spec?.input ?? UNKNOWN_MODEL_DEFAULTS.input,
		cost: FREE,
		contextWindow: totalTokens - maxTokens,
		maxTokens,
		compat: compatFor(spec),
	};
}

/** Catalog used before (or instead of) a successful `/v1/models` call. */
export function staticCatalog(options: CatalogOptions = {}): ProviderModelConfig[] {
	return KNOWN_MODELS.map((spec) => toModelConfig(spec.id, spec, options));
}

export function findSpec(id: string): ModelSpec | undefined {
	return KNOWN_MODELS.find((spec) => spec.id === id || spec.match.test(id));
}

/**
 * `chat_template_kwargs` that switch thinking off for a model id, or undefined
 * when no switch was measured for it.
 *
 * Two callers want this rule and must not disagree about it: `compatFor()`, which
 * hands pi the key so the user's thinking level drives the value, and
 * `hetzner_ask`, which always wants thinking off — the delegate does bulk text
 * work, and a reasoning block that is billed and then discarded is pure cost
 * against the shared per-key output budget. Returning undefined for an unmeasured
 * model is the load-bearing part: a guessed key is accepted with HTTP 200 and
 * ignored, so it would silently bill for thinking while looking like it worked.
 */
export function thinkingOffKwargs(id: string): Record<string, boolean> | undefined {
	const spec = findSpec(id);
	if (!spec?.reasoning || !spec.thinkingKwarg) return undefined;
	return { [spec.thinkingKwarg]: false };
}

export interface MergeResult {
	models: ProviderModelConfig[];
	/** Reported ids with no entry in `KNOWN_MODELS`; registered with defaults. */
	unknownIds: string[];
	/** Documented ids the endpoint no longer reports; dropped from the catalog. */
	retiredIds: string[];
}

/**
 * Merge reported ids with the static metadata.
 *
 * The reported list is authoritative about *which* models exist; this table is
 * authoritative about their properties. Reporting an empty list falls back to
 * the static catalog rather than leaving the provider with no models.
 */
export function mergeCatalog(reportedIds: readonly string[], options: CatalogOptions = {}): MergeResult {
	const ids = [...new Set(reportedIds.map((id) => id.trim()).filter(Boolean))];
	if (ids.length === 0) {
		return { models: staticCatalog(options), unknownIds: [], retiredIds: [] };
	}

	const matched = new Map<string, ModelSpec>();
	const unknownIds: string[] = [];
	for (const id of ids) {
		const spec = findSpec(id);
		if (spec) matched.set(id, spec);
		else unknownIds.push(id);
	}

	const known = [...matched.entries()]
		.sort(([, a], [, b]) => KNOWN_MODELS.indexOf(a) - KNOWN_MODELS.indexOf(b))
		.map(([id, spec]) => toModelConfig(id, spec, options));
	const unknown = unknownIds
		.slice()
		.sort((a, b) => a.localeCompare(b))
		.map((id) => toModelConfig(id, undefined, options));

	const seen = new Set(matched.values());
	return {
		models: [...known, ...unknown],
		unknownIds,
		retiredIds: KNOWN_MODELS.filter((spec) => !seen.has(spec)).map((spec) => spec.id),
	};
}
