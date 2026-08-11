#!/usr/bin/env node
/**
 * Capability probe for the Hetzner Inference API.
 *
 * The published documentation covers models, chat completions and images, but not
 * the things a coding agent depends on: function calling, streaming usage,
 * base64 image input, rate-limit headers. This script measures them and prints a
 * report that maps directly onto the compat flags in `src/catalog.ts`.
 *
 * Usage:
 *   HETZNER_INFERENCE_API_KEY=... node scripts/probe.mjs
 *   node scripts/probe.mjs --token <token> --model Kimi-K2.7-Code --json report.json
 *   node scripts/probe.mjs --overflow            # adds a ~2MB request per model
 *   node scripts/probe.mjs --model GLM-5.2-NVFP4 --timeout 300000
 *
 * It sends a handful of tiny requests per model. Nothing is written anywhere
 * unless --json is passed.
 */

const args = process.argv.slice(2);

function flag(name, fallback) {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const BASE_URL = flag("base-url", process.env.HETZNER_INFERENCE_BASE_URL ?? "https://inference.hetzner.com/api/v1");
const TOKEN = flag("token", process.env.HETZNER_INFERENCE_API_KEY ?? "");
const TIMEOUT_MS = Number(flag("timeout", "60000"));
const JSON_OUT = flag("json", "");
const ONLY_MODELS = args.filter((arg, index) => args[index - 1] === "--model");

/** 1x1 transparent PNG, enough to see whether data: URIs are accepted. */
const TINY_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

if (!TOKEN) {
	console.error("No token. Set HETZNER_INFERENCE_API_KEY or pass --token <token>.");
	process.exit(2);
}

const report = { baseUrl: BASE_URL, models: {}, notes: [] };

async function call(path, body, { stream = false } = {}) {
	const started = Date.now();
	try {
		const response = await fetch(`${BASE_URL}${path}`, {
			method: body ? "POST" : "GET",
			headers: {
				Authorization: `Bearer ${TOKEN}`,
				Accept: stream ? "text/event-stream" : "application/json",
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const headers = Object.fromEntries(response.headers.entries());
		const text = await response.text();
		let json;
		if (!stream) {
			try {
				json = JSON.parse(text);
			} catch {
				/* non-JSON body is reported as text */
			}
		}
		return { ok: response.ok, status: response.status, headers, text, json, ms: Date.now() - started };
	} catch (error) {
		return {
			ok: false,
			status: 0,
			headers: {},
			text: String(error),
			timedOut: error?.name === "TimeoutError",
			ms: Date.now() - started,
		};
	}
}

/**
 * Subset of pi's context-overflow patterns (packages/ai/src/utils/overflow.ts).
 * If the API's overflow error matches none of these, pi cannot auto-compact and
 * retry, and the extension needs a `message_end` normalizer.
 */
const PI_OVERFLOW_PATTERNS = [
	/prompt is too long/i,
	/exceeds the context window/i,
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
	/maximum context length is \d+ tokens/i,
	/reduce the length of the messages/i,
	/context[_ ]length[_ ]exceeded/i,
	/too many tokens/i,
	/token limit exceeded/i,
];

function short(text, limit = 200) {
	const collapsed = String(text ?? "").replace(/\s+/g, " ").trim();
	return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

function mark(value) {
	if (value === true) return "yes";
	if (value === false) return "NO";
	return "n/a";
}

async function probeModels() {
	const result = await call("/models");
	if (!result.ok) {
		console.error(`GET /models failed: HTTP ${result.status} ${short(result.text)}`);
		process.exit(1);
	}
	const ids = (result.json?.data ?? []).map((entry) => entry.id).filter(Boolean);
	report.reportedIds = ids;
	report.modelsEndpointHeaders = result.headers;
	console.log(`# Hetzner Inference probe\n`);
	console.log(`Base URL: ${BASE_URL}`);
	console.log(`GET /models: HTTP ${result.status} in ${result.ms}ms, ${ids.length} model(s)\n`);
	for (const id of ids) console.log(`  - ${id}`);
	console.log("");
	return ONLY_MODELS.length > 0 ? ONLY_MODELS : ids;
}

/**
 * Field names pi reads a separate reasoning channel from, in pi's own precedence
 * order — see `reasoningFields` in pi-ai's `api/openai-completions.js`. Checking
 * only `reasoning_content` is how an earlier run of this probe concluded "no
 * reasoning" for a deployment that returns it under `reasoning`.
 *
 * The test matches pi's: a non-empty string, not merely a present key.
 */
const PI_REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"];

function reasoningFieldOf(message) {
	for (const field of PI_REASONING_FIELDS) {
		const value = message?.[field];
		if (typeof value === "string" && value.length > 0) return field;
	}
	return undefined;
}

async function probeChat(model) {
	const result = await call("/chat/completions", {
		model,
		max_tokens: 32,
		messages: [
			{ role: "system", content: "Answer with a single word." },
			{ role: "user", content: "Say: ready" },
		],
	});
	const message = result.json?.choices?.[0]?.message;
	return {
		ok: result.ok,
		status: result.status,
		ms: result.ms,
		timedOut: result.timedOut,
		error: result.ok ? undefined : short(result.text),
		reply: short(message?.content, 60),
		/** Which channel pi would pick up thinking from; drives `reasoning: true`. */
		reasoningField: reasoningFieldOf(message),
		usage: result.json?.usage,
		rateLimitHeaders: Object.fromEntries(
			Object.entries(result.headers).filter(([name]) => /ratelimit|retry-after/i.test(name)),
		),
	};
}

async function probeMaxCompletionTokens(model) {
	// Not uniform across this deployment: rejected by GLM, accepted by the others.
	// That is why the extension pins `maxTokensField: "max_tokens"`.
	const result = await call("/chat/completions", {
		model,
		max_completion_tokens: 512,
		messages: [{ role: "user", content: "Say: ok" }],
	});
	return { ok: result.ok, status: result.status, error: result.ok ? undefined : short(result.text, 200) };
}

/**
 * Locate the output tokens that are billed but never shown.
 *
 * GLM and Qwen charge ~100-230 output tokens for a one-word answer while
 * `content` holds only the answer and `reasoning_content` is absent. Either the
 * server strips a thinking block, or it lives under a field name this probe does
 * not know. Dumping the raw message keys and a streaming delta settles it — and
 * if a thinking channel does exist, pi can be told about it via `compat`.
 */
async function probeHiddenOutput(model) {
	const nonStreaming = await call("/chat/completions", {
		model,
		max_tokens: 512,
		messages: [{ role: "user", content: "Reply with exactly one word: ready" }],
	});
	const message = nonStreaming.json?.choices?.[0]?.message ?? {};
	const streaming = await call(
		"/chat/completions",
		{
			model,
			max_tokens: 512,
			stream: true,
			messages: [{ role: "user", content: "Reply with exactly one word: ready" }],
		},
		{ stream: true },
	);
	const deltaKeys = new Set();
	for (const line of streaming.text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		try {
			const delta = JSON.parse(line.slice(5).trim())?.choices?.[0]?.delta;
			for (const key of Object.keys(delta ?? {})) deltaKeys.add(key);
		} catch {
			/* [DONE] and keepalives are not JSON */
		}
	}
	return {
		messageKeys: Object.keys(message),
		rawMessage: short(JSON.stringify(message), 300),
		deltaKeys: [...deltaKeys],
		outputTokens: nonStreaming.json?.usage?.completion_tokens,
		contentLength: (message.content ?? "").length,
	};
}

const WEATHER_TOOL = {
	type: "function",
	function: {
		name: "get_weather",
		description: "Get the current weather for a city",
		parameters: {
			type: "object",
			properties: { city: { type: "string", description: "City name" } },
			required: ["city"],
		},
	},
};

/**
 * Function calling.
 *
 * The budget has to clear the model's *thinking* as well as the tool call: these
 * models reason before every answer, and reasoning is billed against `max_tokens`.
 * A budget that only fits the call itself makes a capable model look incapable —
 * it stops at `finish_reason: "length"` mid-thought, having emitted no
 * `tool_calls`. So keep the budget roomy and always report the finish reason,
 * which is what distinguishes "cannot call tools" from "ran out of room".
 *
 * `silencer` is a request fragment already measured to switch this model's
 * thinking off. When the first attempt produces no call, retrying with it shows
 * whether reasoning was the obstacle — and that retry is the configuration pi
 * itself uses at `think:off`.
 */
async function probeTools(model, silencer) {
	const attempt = async (extra) => {
		const result = await call("/chat/completions", {
			model,
			max_tokens: 1024,
			messages: [{ role: "user", content: "What is the weather in Paris right now? Use the available tool." }],
			tools: [WEATHER_TOOL],
			...extra,
		});
		const calls = result.json?.choices?.[0]?.message?.tool_calls;
		return {
			ok: result.ok,
			status: result.status,
			error: result.ok ? undefined : short(result.text, 300),
			called: Array.isArray(calls) && calls.length > 0,
			name: calls?.[0]?.function?.name,
			arguments: short(calls?.[0]?.function?.arguments, 80),
			finishReason: result.json?.choices?.[0]?.finish_reason,
			outputTokens: result.json?.usage?.completion_tokens,
		};
	};

	const plain = await attempt();
	// Only worth a second request when thinking is a plausible explanation.
	const withThinkingOff = !plain.called && plain.ok && silencer ? await attempt(silencer) : undefined;

	const forced = plain.ok
		? await call("/chat/completions", {
				model,
				max_tokens: 1024,
				messages: [{ role: "user", content: "Weather in Paris." }],
				tools: [WEATHER_TOOL],
				tool_choice: { type: "function", function: { name: "get_weather" } },
				...(withThinkingOff?.called ? silencer : {}),
			})
		: undefined;

	return {
		accepted: plain.ok,
		status: plain.status,
		error: plain.error,
		calledTool: plain.called,
		callName: plain.name,
		callArguments: plain.arguments,
		finishReason: plain.finishReason,
		outputTokens: plain.outputTokens,
		thinkingOff: withThinkingOff,
		toolChoiceAccepted: forced ? forced.ok : undefined,
		toolChoiceError: forced && !forced.ok ? short(forced.text, 200) : undefined,
		toolChoiceCalled: forced?.json?.choices?.[0]?.message?.tool_calls?.length > 0,
		toolChoiceFinishReason: forced?.json?.choices?.[0]?.finish_reason,
	};
}

async function probeToolResultRoundTrip(model) {
	// Multi-turn tool result replay is what an agent loop actually does.
	const result = await call("/chat/completions", {
		model,
		max_tokens: 128,
		messages: [
			{ role: "user", content: "What is the weather in Paris?" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "get_weather", arguments: '{"city":"Paris"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_1", name: "get_weather", content: "18°C, light rain" },
		],
		tools: [WEATHER_TOOL],
	});
	return {
		ok: result.ok,
		status: result.status,
		error: result.ok ? undefined : short(result.text, 300),
		reply: short(result.json?.choices?.[0]?.message?.content, 80),
	};
}

async function probeStreaming(model, includeUsage) {
	const result = await call(
		"/chat/completions",
		{
			model,
			max_tokens: 32,
			stream: true,
			...(includeUsage ? { stream_options: { include_usage: true } } : {}),
			messages: [{ role: "user", content: "Count: one two three" }],
		},
		{ stream: true },
	);
	const chunks = result.text.split("\n").filter((line) => line.startsWith("data:"));
	const usageChunk = chunks.find((line) => line.includes('"usage"') && line.includes('"total_tokens"'));
	return {
		ok: result.ok,
		status: result.status,
		error: result.ok ? undefined : short(result.text, 200),
		chunks: chunks.length,
		usageInStream: Boolean(usageChunk),
	};
}

async function probeImage(model) {
	const result = await call("/chat/completions", {
		model,
		max_tokens: 32,
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "Reply with the single word: seen" },
					{ type: "image_url", image_url: { url: TINY_PNG } },
				],
			},
		],
	});
	return {
		ok: result.ok,
		status: result.status,
		error: result.ok ? undefined : short(result.text, 200),
		reply: short(result.json?.choices?.[0]?.message?.content, 40),
	};
}

async function probeMaxTokensCeiling(model) {
	// An impossible output request makes the server state its own max_model_len,
	// which is the authoritative context window.
	const result = await call("/chat/completions", {
		model,
		max_tokens: 100_000_000,
		messages: [{ role: "user", content: "hi" }],
	});
	return { ok: result.ok, status: result.status, message: short(result.text, 300) };
}

async function probeContextOverflow(model) {
	// Genuinely overflow the input so pi's auto-compaction path can be validated.
	// ~340k whitespace-separated words comfortably exceeds a 262k window.
	const filler = "token ".repeat(340_000);
	const result = await call("/chat/completions", {
		model,
		max_tokens: 16,
		messages: [{ role: "user", content: `Summarise:\n${filler}` }],
	});
	const message = result.json?.error?.message ?? result.text;
	return {
		status: result.status,
		timedOut: result.timedOut,
		message: short(message, 300),
		// A timeout says nothing about the error text, so stay undefined rather
		// than reporting a false negative.
		recognisedByPi: result.timedOut ? undefined : PI_OVERFLOW_PATTERNS.some((pattern) => pattern.test(String(message))),
	};
}

/**
 * Some hybrid-reasoning models answer with an empty `content` on a short
 * `max_tokens` budget: the visible answer never arrives because thinking
 * consumed it, either inline as `<think>` tags or on a separate channel. That
 * changes how pi must be configured, so measure it with a roomier budget.
 */
async function probeVisibleOutput(model) {
	const result = await call("/chat/completions", {
		model,
		max_tokens: 512,
		messages: [{ role: "user", content: "Reply with exactly one word: ready" }],
	});
	const message = result.json?.choices?.[0]?.message;
	const content = message?.content ?? "";
	return {
		ok: result.ok,
		error: result.ok ? undefined : short(result.text, 200),
		finishReason: result.json?.choices?.[0]?.finish_reason,
		contentLength: content.length,
		preview: short(content, 120),
		thinkTags: /<\/?(think|thinking|reasoning|thought)\b/i.test(content),
		reasoningField: reasoningFieldOf(message),
		reasoningLength: (message?.[reasoningFieldOf(message) ?? ""] ?? "").length,
		outputTokens: result.json?.usage?.completion_tokens,
	};
}

/**
 * Whether `reasoning_effort` is accepted.
 *
 * This decides whether `reasoning: true` is safe. pi sends `reasoning_effort`
 * when `model.reasoning && compat.supportsReasoningEffort`, and that flag
 * defaults to *auto-detected from the base URL* — an unknown value for this
 * deployment. Setting `reasoning: true` while the server rejects the parameter
 * would break every request, the same way `max_completion_tokens` breaks GLM.
 */
async function probeReasoningEffort(model) {
	const result = await call("/chat/completions", {
		model,
		max_tokens: 512,
		reasoning_effort: "low",
		messages: [{ role: "user", content: "Reply with exactly one word: ready" }],
	});
	return {
		ok: result.ok,
		status: result.status,
		error: result.ok ? undefined : short(result.text, 200),
		reasoningLength: (result.json?.choices?.[0]?.message?.[
			reasoningFieldOf(result.json?.choices?.[0]?.message) ?? ""
		] ?? "").length,
	};
}

/**
 * Whether the thinking channel can be switched off.
 *
 * These models think unprompted and bill for it. If one of the vLLM chat-template
 * switches silences it, pi can drive that through `compat.thinkingFormat` and the
 * user gets a working `think:off`. Accepting the parameter is not enough — a
 * server that ignores an unknown kwarg still answers HTTP 200, so the measurement
 * that counts is whether the reasoning channel actually went away.
 */
const THINKING_SWITCHES = [
	{ label: "chat_template_kwargs.enable_thinking", body: { chat_template_kwargs: { enable_thinking: false } } },
	{ label: "chat_template_kwargs.thinking", body: { chat_template_kwargs: { thinking: false } } },
	{ label: "enable_thinking (top level)", body: { enable_thinking: false } },
];

async function probeThinkingToggle(model) {
	const attempts = [];
	for (const variant of THINKING_SWITCHES) {
		const result = await call("/chat/completions", {
			model,
			max_tokens: 512,
			messages: [{ role: "user", content: "Reply with exactly one word: ready" }],
			...variant.body,
		});
		const message = result.json?.choices?.[0]?.message;
		const field = reasoningFieldOf(message);
		attempts.push({
			label: variant.label,
			// Kept so a later probe can re-run under the configuration pi will
			// actually use once this switch is wired into `compat`.
			body: variant.body,
			accepted: result.ok,
			error: result.ok ? undefined : short(result.text, 120),
			// The only outcome that matters: did the reasoning channel go quiet?
			silenced: result.ok && field === undefined,
			outputTokens: result.json?.usage?.completion_tokens,
		});
	}
	return attempts;
}

const models = await probeModels();

for (const model of models) {
	console.log(`\n## ${model}\n`);
	const entry = {};
	report.models[model] = entry;

	entry.chat = await probeChat(model);
	if (!entry.chat.ok) {
		if (entry.chat.timedOut) {
			console.log(`  chat                     TIMEOUT after ${entry.chat.ms}ms — model may be cold or overloaded`);
			console.log(`                           retry with: node scripts/probe.mjs --model ${model} --timeout 300000`);
		} else {
			console.log(`  chat                     FAILED (HTTP ${entry.chat.status}) ${entry.chat.error}`);
		}
		continue;
	}
	console.log(`  chat                     ok in ${entry.chat.ms}ms — "${entry.chat.reply}"`);
	console.log(
		`  reasoning channel        ${entry.chat.reasoningField ?? "none"}` +
			`${entry.chat.reasoningField ? ` — pi reads this; set reasoning: true` : ""}`,
	);

	entry.visibleOutput = await probeVisibleOutput(model);
	if (entry.visibleOutput.ok) {
		const visible = entry.visibleOutput;
		console.log(
			`  visible answer (512 tok) ${visible.contentLength > 0 ? `"${visible.preview}"` : "EMPTY"}` +
				` [finish: ${visible.finishReason}, ${visible.outputTokens} output tokens]`,
		);
		if (visible.thinkTags) console.log(`  inline think tags        yes — pi needs compat.thinkingFormat / requiresThinkingAsText`);
		if (visible.reasoningField) {
			console.log(`  reasoning text           ${visible.reasoningLength} chars on "${visible.reasoningField}"`);

			// Both of these decide whether `reasoning: true` is safe and whether
			// pi's think:off can ever do anything, so only run them when there is
			// a reasoning channel to control.
			entry.reasoningEffort = await probeReasoningEffort(model);
			console.log(
				`  reasoning_effort         ${mark(entry.reasoningEffort.ok)}` +
					`${entry.reasoningEffort.error ? ` — ${entry.reasoningEffort.error}` : ` (${entry.reasoningEffort.reasoningLength} chars of reasoning)`}`,
			);

			entry.thinkingToggle = await probeThinkingToggle(model);
			for (const attempt of entry.thinkingToggle) {
				const outcome = !attempt.accepted
					? `rejected — ${attempt.error}`
					: attempt.silenced
						? "SILENCED the reasoning channel"
						: `accepted but ignored (${attempt.outputTokens} output tokens, still reasoning)`;
				console.log(`  off via ${attempt.label.padEnd(16)} ${outcome}`);
			}
		}

		// A one-word answer that costs many output tokens means hidden work.
		if (visible.outputTokens > 4 * Math.max(1, Math.ceil(visible.contentLength / 4))) {
			const hidden = await probeHiddenOutput(model);
			entry.hiddenOutput = hidden;
			console.log(`  hidden output tokens     ${hidden.outputTokens} billed for ${hidden.contentLength} chars of content`);
			console.log(`  message fields           ${hidden.messageKeys.join(", ") || "none"}`);
			console.log(`  stream delta fields      ${hidden.deltaKeys.join(", ") || "none"}`);
			console.log(`  raw message              ${hidden.rawMessage}`);
		}
	} else {
		console.log(`  visible answer (512 tok) FAILED — ${entry.visibleOutput.error}`);
	}

	// Re-use whichever switch was measured to silence this model's thinking.
	const silencer = entry.thinkingToggle?.find((attempt) => attempt.silenced)?.body;
	entry.tools = await probeTools(model, silencer);
	console.log(`  tools accepted           ${mark(entry.tools.accepted)}${entry.tools.error ? ` — ${entry.tools.error}` : ""}`);
	console.log(
		`  tool call emitted        ${mark(entry.tools.calledTool)}` +
			`${entry.tools.callName ? ` (${entry.tools.callName} ${entry.tools.callArguments})` : ""}` +
			`${entry.tools.calledTool ? "" : ` [finish: ${entry.tools.finishReason}, ${entry.tools.outputTokens} output tokens]`}`,
	);
	if (entry.tools.thinkingOff) {
		const retry = entry.tools.thinkingOff;
		console.log(
			`  tool call, thinking off  ${mark(retry.called)}` +
				`${retry.called ? ` (${retry.name}) — thinking was the obstacle, not tool support` : ` [finish: ${retry.finishReason}]`}`,
		);
	}
	console.log(
		`  tool_choice forced       ${mark(entry.tools.toolChoiceAccepted && entry.tools.toolChoiceCalled)}` +
			`${entry.tools.toolChoiceError ? ` — ${entry.tools.toolChoiceError}` : ""}` +
			`${entry.tools.toolChoiceAccepted && !entry.tools.toolChoiceCalled ? ` [finish: ${entry.tools.toolChoiceFinishReason}]` : ""}`,
	);

	if (entry.tools.calledTool || entry.tools.thinkingOff?.called) {
		entry.toolRoundTrip = await probeToolResultRoundTrip(model);
		console.log(`  tool result replay       ${mark(entry.toolRoundTrip.ok)}${entry.toolRoundTrip.error ? ` — ${entry.toolRoundTrip.error}` : ""}`);
	}

	entry.streamWithUsage = await probeStreaming(model, true);
	if (!entry.streamWithUsage.ok) {
		entry.streamPlain = await probeStreaming(model, false);
		console.log(`  stream_options           NO — ${entry.streamWithUsage.error}`);
		console.log(`  streaming (plain)        ${mark(entry.streamPlain.ok)} (${entry.streamPlain.chunks} chunks)`);
	} else {
		console.log(`  streaming                ok (${entry.streamWithUsage.chunks} chunks)`);
		console.log(`  usage in stream          ${mark(entry.streamWithUsage.usageInStream)}`);
	}

	entry.image = await probeImage(model);
	console.log(`  base64 image input       ${mark(entry.image.ok)}${entry.image.error ? ` — ${entry.image.error}` : ` — "${entry.image.reply}"`}`);

	entry.maxCompletionTokens = await probeMaxCompletionTokens(model);
	console.log(
		`  max_completion_tokens    ${mark(entry.maxCompletionTokens.ok)}` +
			`${entry.maxCompletionTokens.error ? ` — ${entry.maxCompletionTokens.error}` : ""}`,
	);

	entry.maxTokensCeiling = await probeMaxTokensCeiling(model);
	console.log(`  max_tokens ceiling       HTTP ${entry.maxTokensCeiling.status} — ${entry.maxTokensCeiling.message}`);

	if (args.includes("--overflow")) {
		entry.contextOverflow = await probeContextOverflow(model);
		if (entry.contextOverflow.timedOut) {
			console.log(`  context overflow         inconclusive — the oversized request timed out, not the API's fault`);
			console.log(`                           retry with: node scripts/probe.mjs --overflow --model ${model} --timeout 300000`);
		} else {
			console.log(`  context overflow error   HTTP ${entry.contextOverflow.status} — ${entry.contextOverflow.message}`);
			console.log(`  pi recognises overflow   ${mark(entry.contextOverflow.recognisedByPi)}`);
		}
	}

	const limits = Object.entries(entry.chat.rateLimitHeaders);
	console.log(`  rate-limit headers       ${limits.length > 0 ? limits.map(([k, v]) => `${k}: ${v}`).join(", ") : "none"}`);
}

console.log("\n## Verdict\n");
const agentCapable = Object.entries(report.models).filter(
	([, entry]) => entry.tools?.calledTool || entry.tools?.thinkingOff?.called,
);
if (agentCapable.length > 0) {
	console.log(
		`Usable as pi's main model (function calling works): ${agentCapable
			.map(([id, entry]) => (entry.tools.calledTool ? id : `${id} (only with thinking off)`))
			.join(", ")}`,
	);
} else {
	console.log("No model emitted a tool call. These models cannot drive pi's agent loop;");
	console.log("use them through the hetzner_ask delegation tool instead (/hetzner ask on).");
}
const vision = Object.entries(report.models).filter(([, entry]) => entry.image?.ok);
console.log(`Accepts base64 images: ${vision.length > 0 ? vision.map(([id]) => id).join(", ") : "none"}`);
const reasoning = Object.entries(report.models).filter(([, entry]) => entry.chat?.reasoningField);
console.log(
	`Returns a reasoning channel: ${
		reasoning.length > 0 ? reasoning.map(([id, entry]) => `${id} (${entry.chat.reasoningField})`).join(", ") : "none"
	}`,
);
const effortRejected = reasoning.filter(([, entry]) => entry.reasoningEffort && !entry.reasoningEffort.ok);
if (effortRejected.length > 0) {
	console.log(`Rejects reasoning_effort: ${effortRejected.map(([id]) => id).join(", ")} — keep compat.supportsReasoningEffort false`);
}
const silenceable = reasoning.filter(([, entry]) => entry.thinkingToggle?.some((attempt) => attempt.silenced));
console.log(
	silenceable.length > 0
		? `Thinking can be switched off: ${silenceable
				.map(([id, entry]) => `${id} via ${entry.thinkingToggle.find((a) => a.silenced).label}`)
				.join(", ")}`
		: "Thinking cannot be switched off by any known switch: these models always reason, and always bill for it.",
);
const unreachable = Object.entries(report.models).filter(([, entry]) => entry.chat && !entry.chat.ok);
if (unreachable.length > 0) {
	console.log(
		`Did not answer: ${unreachable
			.map(([id, entry]) => `${id} (${entry.chat.timedOut ? `timeout after ${entry.chat.ms}ms` : `HTTP ${entry.chat.status}`})`)
			.join(", ")}`,
	);
}

if (JSON_OUT) {
	const { writeFileSync } = await import("node:fs");
	writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
	console.log(`\nJSON report written to ${JSON_OUT}`);
}
