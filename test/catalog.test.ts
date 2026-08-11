import assert from "node:assert/strict";
import { test } from "node:test";
import { KNOWN_MODELS, mergeCatalog, staticCatalog, UNKNOWN_MODEL_DEFAULTS } from "../src/catalog.ts";

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
	assert.equal(model?.contextWindow, 262_144);
	assert.deepEqual(model?.input, ["text", "image"]);
	assert.deepEqual(result.unknownIds, []);
});

test("unknown ids are registered with conservative defaults", () => {
	const result = mergeCatalog(["Some-New-Model-2027"]);
	assert.deepEqual(result.unknownIds, ["Some-New-Model-2027"]);
	const [model] = result.models;
	assert.equal(model?.contextWindow, UNKNOWN_MODEL_DEFAULTS.contextWindow);
	assert.deepEqual(model?.input, ["text"]);
	assert.equal(model?.reasoning, false);
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
