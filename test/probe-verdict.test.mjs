import assert from "node:assert/strict";
import test from "node:test";

import { evaluateProbe, KNOWN_PROBE_MODELS } from "../scripts/probe-verdict.mjs";

function passingReport() {
	const models = Object.fromEntries(Object.entries(KNOWN_PROBE_MODELS).map(([id, expected]) => [id, {
		chat: { ok: true },
		visibleOutput: { ok: true, preview: "ready", reasoningField: "reasoning" },
		thinkingToggle: [{ label: expected.thinkingSwitch, silenced: true }],
		tools: { calledTool: true, toolChoiceAccepted: true, toolChoiceCalled: true },
		toolRoundTrip: { ok: true },
		streamWithUsage: { ok: true, usageInStream: true },
		image: { ok: expected.image, status: expected.image ? 200 : 400, error: expected.image ? undefined : "not a multimodal model" },
		maxTokensCeiling: { ok: false, status: 400, message: `maximum context length is ${expected.totalTokens} tokens` },
		contextOverflow: { recognisedByPi: true },
	}]));
	return { reportedIds: Object.keys(KNOWN_PROBE_MODELS), models };
}

test("strict probe verdict passes all load-bearing capabilities and skips optional overflow", () => {
	const verdict = evaluateProbe(passingReport());
	assert.equal(verdict.status, "pass");
	assert.equal(verdict.failures, 0);
	assert.equal(verdict.inconclusive, 0);
	assert.equal(verdict.checks.at(-1)?.status, "skipped");
});

test("strict probe verdict fails missing models, empty output, and capability drift", () => {
	const report = passingReport();
	report.reportedIds.pop();
	report.models["Kimi-K2.7-Code"].visibleOutput.preview = "";
	report.models["Kimi-K2.7-Code"].tools.toolChoiceCalled = false;
	const verdict = evaluateProbe(report);
	assert.equal(verdict.status, "fail");
	assert.ok(verdict.checks.some((check) => check.check === "listed by GET /models" && check.status === "fail"));
	assert.ok(verdict.checks.some((check) => check.check === "visible output" && check.status === "fail"));
	assert.ok(verdict.checks.some((check) => check.check === "forced tool_choice" && check.status === "fail"));
});

test("timeouts and requested-but-missing overflow probes are inconclusive", () => {
	const report = passingReport();
	const model = report.models["GLM-5.2-NVFP4"];
	model.chat = { ok: false, timedOut: true };
	model.visibleOutput = { ok: false, timedOut: true };
	model.image = { ok: false, timedOut: true };
	model.tools.toolChoiceTimedOut = true;
	report.models["Qwen/Qwen3.6-35B-A3B-FP8"].tools = { timedOut: true };
	delete model.contextOverflow;
	const verdict = evaluateProbe(report, { overflowRequested: true });
	assert.equal(verdict.status, "inconclusive");
	for (const check of ["chat with max_tokens", "visible output", "reasoning channel", "forced tool_choice", "base64 image rejected as non-multimodal", "pi-recognised overflow error"]) {
		assert.ok(verdict.checks.some((item) => item.model === "GLM-5.2-NVFP4" && item.check === check && item.status === "inconclusive"));
	}
	for (const check of ["tool call", "forced tool_choice"]) {
		assert.ok(verdict.checks.some((item) => item.model === "Qwen/Qwen3.6-35B-A3B-FP8" && item.check === check && item.status === "inconclusive"));
	}
});
