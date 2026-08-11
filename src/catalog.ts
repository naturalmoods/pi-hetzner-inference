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
 * Conservative compat flags for a self-hosted OpenAI-compatible server.
 *
 * These avoid OpenAI-only request fields that such servers reject:
 * - `developer` role is OpenAI-specific, `system` is universal.
 * - `store` is an OpenAI platform feature.
 * - strict function schemas and OpenAI grammar tools are not generally supported;
 *   turning them off falls back to plain function tools.
 * - `max_tokens` is accepted everywhere, `max_completion_tokens` is not.
 *
 * Reasoning stays off until `scripts/probe.mjs` confirms how (and whether) the
 * deployment exposes thinking for the hybrid models. Users can turn it on per
 * model through `modelOverrides` in `~/.pi/agent/models.json` — see README.
 */
const COMPAT: ProviderModelConfig["compat"] = {
	supportsDeveloperRole: false,
	supportsStore: false,
	supportsStrictMode: false,
	supportsOpenAIGrammarTools: false,
	maxTokensField: "max_tokens",
};

/** Default output cap. One response stays well inside the 200k/60s output budget. */
export const DEFAULT_MAX_TOKENS = 32_768;

/** Defaults for a model id this package does not know yet. */
export const UNKNOWN_MODEL_DEFAULTS = {
	contextWindow: 128_000,
	input: ["text"] as ("text" | "image")[],
};

export interface ModelSpec {
	/** Documented id, used when `/v1/models` cannot be reached. */
	id: string;
	/** Display name. Keeps the provider visible in model pickers. */
	name: string;
	/** Matches the reported id, which may carry an org prefix or a version suffix. */
	match: RegExp;
	contextWindow: number;
	input: ("text" | "image")[];
	/** Shown by `/hetzner models`. */
	note: string;
}

/** Documented catalog as of 2026-08. Order drives the display order. */
export const KNOWN_MODELS: readonly ModelSpec[] = [
	{
		id: "Kimi-K2.7-Code",
		name: "Kimi K2.7 Code (Hetzner)",
		match: /kimi-k2(\.7)?-code/i,
		contextWindow: 262_144,
		input: ["text", "image"],
		note: "MoE 1T total / 32B active, code-tuned",
	},
	{
		id: "GLM-5.2-NVFP4",
		name: "GLM 5.2 (Hetzner)",
		match: /glm-5(\.2)?/i,
		contextWindow: 512_000,
		input: ["text"],
		note: "MoE 744B total / 40B active",
	},
	{
		id: "DeepSeek-V4-Flash-0731",
		name: "DeepSeek V4 Flash (Hetzner)",
		match: /deepseek-v4-flash/i,
		contextWindow: 512_000,
		input: ["text"],
		note: "MoE 304B total / 13B active",
	},
	{
		id: "Qwen/Qwen3.6-35B-A3B-FP8",
		name: "Qwen3.6 35B A3B (Hetzner)",
		match: /qwen3(\.6)?-35b-a3b/i,
		contextWindow: 262_144,
		input: ["text", "image"],
		note: "MoE 35B total / 3B active",
	},
];

export interface CatalogOptions {
	maxTokens?: number;
}

function toModelConfig(
	id: string,
	spec: ModelSpec | undefined,
	options: CatalogOptions,
): ProviderModelConfig {
	return {
		id,
		name: spec?.name ?? `${id} (Hetzner)`,
		reasoning: false,
		input: spec?.input ?? UNKNOWN_MODEL_DEFAULTS.input,
		cost: FREE,
		contextWindow: spec?.contextWindow ?? UNKNOWN_MODEL_DEFAULTS.contextWindow,
		maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
		compat: COMPAT,
	};
}

/** Catalog used before (or instead of) a successful `/v1/models` call. */
export function staticCatalog(options: CatalogOptions = {}): ProviderModelConfig[] {
	return KNOWN_MODELS.map((spec) => toModelConfig(spec.id, spec, options));
}

export function findSpec(id: string): ModelSpec | undefined {
	return KNOWN_MODELS.find((spec) => spec.id === id || spec.match.test(id));
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
