import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_TOKENS,
	KNOWN_MODELS,
	MIN_MAX_TOKENS,
	mergeCatalog,
	staticCatalog,
	thinkingOffKwargs,
	UNKNOWN_MODEL_DEFAULTS,
} from "../src/catalog.ts";

test("static catalog covers every documented model", () => {
	const models = staticCatalog();
	assert.equal(models.length, KNOWN_MODELS.length);
	assert.ok(models.every((model) => model.cost.input === 0 && model.cost.output === 0));
});

test("an empty report falls back to the static catalog", () => {
	const result = mergeCatalog([]);
	assert.equal(result.models.length, KNOWN_MODELS.length);
	assert.deepEqual(result.unknownIds, []);
	assert.deepEqual(result.retiredIds, []);
});

test("reported ids keep their exact spelling but take metadata from the table", () => {
	const result = mergeCatalog(["moonshotai/Kimi-K2.7-Code"]);
	assert.equal(result.models.length, 1);
	const [model] = result.models;
	assert.equal(model?.id, "moonshotai/Kimi-K2.7-Code");
	// max_model_len 262144 minus the reserved output room.
	assert.equal(model?.contextWindow, 262_144 - DEFAULT_MAX_TOKENS);
	assert.deepEqual(model?.input, ["text", "image"]);
	assert.deepEqual(result.unknownIds, []);
});

test("unknown ids are registered with conservative defaults", () => {
	const result = mergeCatalog(["Some-New-Model-2027"]);
	assert.deepEqual(result.unknownIds, ["Some-New-Model-2027"]);
	const [model] = result.models;
	assert.equal(model?.contextWindow, UNKNOWN_MODEL_DEFAULTS.totalTokens - DEFAULT_MAX_TOKENS);
	assert.deepEqual(model?.input, ["text"]);
	assert.equal(model?.reasoning, false);
});

test("output room is reserved so input plus maxTokens never exceeds max_model_len", () => {
	for (const maxTokens of [1024, DEFAULT_MAX_TOKENS, 200_000]) {
		const [model] = mergeCatalog(["Kimi-K2.7-Code"], { maxTokens }).models;
		assert.ok(model);
		assert.equal(model.contextWindow + model.maxTokens, 262_144);
	}
});

test("an absurd maxTokens is clamped instead of erasing the context window", () => {
	const [model] = mergeCatalog(["Kimi-K2.7-Code"], { maxTokens: 10_000_000 }).models;
	assert.equal(model?.maxTokens, 131_072);
	assert.equal(model?.contextWindow, 131_072);
});

test("a tiny maxTokens is raised to the floor that hidden thinking needs", () => {
	const [model] = mergeCatalog(["Kimi-K2.7-Code"], { maxTokens: 64 }).models;
	assert.equal(model?.maxTokens, MIN_MAX_TOKENS);
});

test("models missing from the report are retired, not registered", () => {
	const result = mergeCatalog(["GLM-5.2-NVFP4"]);
	assert.equal(result.models.length, 1);
	assert.equal(result.retiredIds.length, KNOWN_MODELS.length - 1);
	assert.ok(!result.retiredIds.includes("GLM-5.2-NVFP4"));
});

test("known models sort before unknown ones, duplicates collapse", () => {
	const result = mergeCatalog(["zz-unknown", "GLM-5.2-NVFP4", "GLM-5.2-NVFP4", "aa-unknown"]);
	assert.deepEqual(
		result.models.map((model) => model.id),
		["GLM-5.2-NVFP4", "aa-unknown", "zz-unknown"],
	);
});

test("maxTokens is configurable", () => {
	const result = mergeCatalog(["GLM-5.2-NVFP4"], { maxTokens: 4096 });
	assert.equal(result.models[0]?.maxTokens, 4096);
});

/**
 * `compat` is a union across pi's four API flavours. This provider is always
 * `openai-completions`, so narrow to that member before reading its fields.
 */
function completionsCompat(model: ProviderModelConfig | undefined) {
	const compat = model?.compat;
	if (!compat || !("maxTokensField" in compat)) {
		throw new Error(`${model?.id ?? "model"} is not configured with openai-completions compat`);
	}
	return compat;
}

test("each reasoning model carries the thinking switch measured for it", () => {
	// The keys are not interchangeable: sending Kimi's key to Qwen is accepted and
	// silently ignored, which would make think:off a no-op instead of an error.
	for (const [id, kwarg] of [
		["Kimi-K2.7-Code", "thinking"],
		["DeepSeek-V4-Flash-0731", "thinking"],
		["GLM-5.2-NVFP4", "thinking"],
		["Qwen/Qwen3.6-35B-A3B-FP8", "enable_thinking"],
	] as const) {
		const [model] = mergeCatalog([id]).models;
		assert.equal(model?.reasoning, true, `${id} should report reasoning`);
		const compat = completionsCompat(model);
		assert.equal(compat.thinkingFormat, "chat-template");
		assert.deepEqual(compat.chatTemplateKwargs, { [kwarg]: { $var: "thinking.enabled" } });
	}
});

test("every documented model now has a measured thinking switch", () => {
	// If a model is added to the table without probing its switch, this fails —
	// which is the point. `reasoning: true` with an unverified key gives pi a
	// think:off that silently does nothing.
	for (const model of staticCatalog()) {
		assert.equal(model.reasoning, true, `${model.id} has no measured reasoning setting`);
		assert.equal(completionsCompat(model).thinkingFormat, "chat-template", `${model.id} has no thinking switch`);
	}
});

test("hetzner_ask switches thinking off only where a switch was measured", () => {
	// The delegate discards reasoning, so paying for it is waste — but a guessed
	// key is accepted with HTTP 200 and ignored, which would bill for thinking
	// while looking like it worked. Unknown ids must get no kwargs at all.
	assert.deepEqual(thinkingOffKwargs("Kimi-K2.7-Code"), { thinking: false });
	assert.deepEqual(thinkingOffKwargs("GLM-5.2-NVFP4"), { thinking: false });
	assert.deepEqual(thinkingOffKwargs("Qwen/Qwen3.6-35B-A3B-FP8"), { enable_thinking: false });
	// Prefixed ids reach the same spec as the catalog merge does.
	assert.deepEqual(thinkingOffKwargs("moonshotai/Kimi-K2.7-Code"), { thinking: false });
	assert.equal(thinkingOffKwargs("Some-New-Model-2027"), undefined);
	assert.equal(thinkingOffKwargs(""), undefined);
});

test("every documented model can have its thinking switched off by the delegate", () => {
	for (const spec of KNOWN_MODELS) {
		assert.ok(thinkingOffKwargs(spec.id), `${spec.id} has no delegate thinking switch`);
	}
});

test("a model whose thinking control is unmeasured sends no thinking switch", () => {
	// pi still renders any reasoning an unknown model returns; what must not
	// happen is pi believing it can switch that thinking off.
	const [unknown] = mergeCatalog(["Some-New-Model-2027"]).models;
	assert.equal(unknown?.reasoning, false);
	assert.equal(completionsCompat(unknown).thinkingFormat, undefined);
	assert.equal(completionsCompat(unknown).chatTemplateKwargs, undefined);
});

test("max_tokens stays pinned for every model, reasoning or not", () => {
	// GLM rejects max_completion_tokens outright; the flag must survive the
	// per-model compat merge rather than being replaced by it.
	for (const model of staticCatalog()) {
		const compat = completionsCompat(model);
		assert.equal(compat.maxTokensField, "max_tokens", `${model.id} lost maxTokensField`);
		assert.equal(compat.supportsUsageInStreaming, true, `${model.id} lost supportsUsageInStreaming`);
	}
});
