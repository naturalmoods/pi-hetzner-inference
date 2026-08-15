export const KNOWN_PROBE_MODELS = {
	"Kimi-K2.7-Code": {
		image: true,
		thinkingSwitch: "chat_template_kwargs.thinking",
		totalTokens: 262_144,
	},
	"GLM-5.2-NVFP4": {
		image: false,
		thinkingSwitch: "chat_template_kwargs.thinking",
		totalTokens: 512_000,
	},
	"DeepSeek-V4-Flash-0731": {
		image: false,
		thinkingSwitch: "chat_template_kwargs.thinking",
		totalTokens: 512_000,
	},
	"Qwen/Qwen3.6-35B-A3B-FP8": {
		image: true,
		thinkingSwitch: "chat_template_kwargs.enable_thinking",
		totalTokens: 262_144,
	},
};

function result(checks, model, check, value, detail) {
	checks.push({
		model,
		check,
		status: value === undefined ? "inconclusive" : value ? "pass" : "fail",
		...(detail ? { detail } : {}),
	});
}

/** Convert raw probe observations into the release gate's machine-readable verdict. */
export function evaluateProbe(report, { overflowRequested = false } = {}) {
	const checks = [];
	const reported = new Set(report.reportedIds ?? []);

	for (const [model, expected] of Object.entries(KNOWN_PROBE_MODELS)) {
		result(checks, model, "listed by GET /models", reported.has(model));
		const entry = report.models?.[model];
		if (!entry) {
			result(checks, model, "capability probes completed", undefined, "model was not probed");
			continue;
		}

		result(checks, model, "chat with max_tokens", entry.chat?.timedOut ? undefined : entry.chat?.ok);
		result(
			checks,
			model,
			"visible output",
			entry.visibleOutput?.timedOut
				? undefined
				: entry.visibleOutput
					? Boolean(entry.visibleOutput.ok && entry.visibleOutput.preview)
					: undefined,
		);
		result(
			checks,
			model,
			"reasoning channel",
			entry.visibleOutput?.timedOut
				? undefined
				: entry.visibleOutput
					? Boolean(entry.visibleOutput.reasoningField)
					: undefined,
		);
		const thinkingAttempt = entry.thinkingToggle?.find((attempt) => attempt.label === expected.thinkingSwitch);
		result(
			checks,
			model,
			`thinking switch ${expected.thinkingSwitch}`,
			thinkingAttempt?.timedOut ? undefined : thinkingAttempt?.silenced,
		);
		result(
			checks,
			model,
			"tool call",
			entry.tools?.timedOut || entry.tools?.thinkingOff?.timedOut
				? undefined
				: entry.tools
					? Boolean(entry.tools.calledTool || entry.tools.thinkingOff?.called)
					: undefined,
		);
		result(
			checks,
			model,
			"forced tool_choice",
			entry.tools?.timedOut || entry.tools?.toolChoiceTimedOut
				? undefined
				: entry.tools?.toolChoiceAccepted === undefined
					? undefined
					: Boolean(entry.tools.toolChoiceAccepted && entry.tools.toolChoiceCalled),
		);
		result(
			checks,
			model,
			"tool result replay",
			entry.toolRoundTrip?.timedOut ? undefined : entry.toolRoundTrip?.ok,
		);
		result(
			checks,
			model,
			"streaming usage",
			entry.streamWithUsage?.timedOut
				? undefined
				: entry.streamWithUsage
					? Boolean(entry.streamWithUsage.ok && entry.streamWithUsage.usageInStream)
					: undefined,
		);
		result(
			checks,
			model,
			expected.image ? "base64 image accepted" : "base64 image rejected as non-multimodal",
			entry.image?.timedOut
				? undefined
				: entry.image
					? expected.image
						? entry.image.ok
						: !entry.image.ok && /not a multimodal model|image.*not supported|does not support (image|vision)/i.test(entry.image.error ?? "")
					: undefined,
		);

		const ceiling = entry.maxTokensCeiling;
		const ceilingText = ceiling?.message?.replaceAll(",", "");
		result(
			checks,
			model,
			`context ceiling ${expected.totalTokens}`,
			ceiling?.timedOut
				? undefined
				: ceiling
					? !ceiling.ok && ceiling.status > 0 && ceilingText?.includes(String(expected.totalTokens)) === true
					: undefined,
		);

		if (overflowRequested) {
			const overflow = entry.contextOverflow;
			result(
				checks,
				model,
				"pi-recognised overflow error",
				overflow?.timedOut ? undefined : overflow?.recognisedByPi,
			);
		}
	}

	if (!overflowRequested) {
		checks.push({ model: "all", check: "overflow request", status: "skipped", detail: "run with --overflow to require it" });
	}

	const failures = checks.filter((check) => check.status === "fail").length;
	const inconclusive = checks.filter((check) => check.status === "inconclusive").length;
	return {
		status: failures > 0 ? "fail" : inconclusive > 0 ? "inconclusive" : "pass",
		failures,
		inconclusive,
		checks,
	};
}
