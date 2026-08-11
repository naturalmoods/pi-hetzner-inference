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
		/** vLLM-style separate reasoning channel; drives `reasoning: true` + thinking format. */
		reasoningContent: message?.reasoning_content !== undefined,
		usage: result.json?.usage,
		rateLimitHeaders: Object.fromEntries(
			Object.entries(result.headers).filter(([name]) => /ratelimit|retry-after/i.test(name)),
		),
	};
}

async function probeMaxCompletionTokens(model) {
	// If this is accepted, `maxTokensField: "max_completion_tokens"` is also an option.
	const result = await call("/chat/completions", {
		model,
		max_completion_tokens: 16,
		messages: [{ role: "user", content: "Say: ok" }],
	});
	return { ok: result.ok, status: result.status, error: result.ok ? undefined : short(result.text, 120) };
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

async function probeTools(model) {
	const result = await call("/chat/completions", {
		model,
		max_tokens: 256,
		messages: [{ role: "user", content: "What is the weather in Paris right now? Use the available tool." }],
		tools: [WEATHER_TOOL],
	});
	const message = result.json?.choices?.[0]?.message;
	const calls = message?.tool_calls;
	const forced = result.ok
		? await call("/chat/completions", {
				model,
				max_tokens: 256,
				messages: [{ role: "user", content: "Weather in Paris." }],
				tools: [WEATHER_TOOL],
				tool_choice: { type: "function", function: { name: "get_weather" } },
			})
		: undefined;

	return {
		accepted: result.ok,
		status: result.status,
		error: result.ok ? undefined : short(result.text, 300),
		calledTool: Array.isArray(calls) && calls.length > 0,
		callName: calls?.[0]?.function?.name,
		callArguments: short(calls?.[0]?.function?.arguments, 80),
		finishReason: result.json?.choices?.[0]?.finish_reason,
		toolChoiceAccepted: forced ? forced.ok : undefined,
		toolChoiceError: forced && !forced.ok ? short(forced.text, 200) : undefined,
		toolChoiceCalled: forced?.json?.choices?.[0]?.message?.tool_calls?.length > 0,
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
		reasoningContent: message?.reasoning_content !== undefined,
		outputTokens: result.json?.usage?.completion_tokens,
	};
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
	console.log(`  reasoning_content        ${mark(entry.chat.reasoningContent)}`);

	entry.visibleOutput = await probeVisibleOutput(model);
	if (entry.visibleOutput.ok) {
		const visible = entry.visibleOutput;
		console.log(
			`  visible answer (512 tok) ${visible.contentLength > 0 ? `"${visible.preview}"` : "EMPTY"}` +
				` [finish: ${visible.finishReason}, ${visible.outputTokens} output tokens]`,
		);
		if (visible.thinkTags) console.log(`  inline think tags        yes — pi needs compat.thinkingFormat / requiresThinkingAsText`);
		if (visible.contentLength === 0) {
			console.log(`  ! empty content with ${visible.outputTokens} output tokens billed — output goes somewhere pi cannot see`);
		}
	} else {
		console.log(`  visible answer (512 tok) FAILED — ${entry.visibleOutput.error}`);
	}

	entry.tools = await probeTools(model);
	console.log(`  tools accepted           ${mark(entry.tools.accepted)}${entry.tools.error ? ` — ${entry.tools.error}` : ""}`);
	console.log(`  tool call emitted        ${mark(entry.tools.calledTool)}${entry.tools.callName ? ` (${entry.tools.callName} ${entry.tools.callArguments})` : ""}`);
	console.log(`  tool_choice forced       ${mark(entry.tools.toolChoiceAccepted && entry.tools.toolChoiceCalled)}${entry.tools.toolChoiceError ? ` — ${entry.tools.toolChoiceError}` : ""}`);

	if (entry.tools.calledTool) {
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
	console.log(`  max_completion_tokens    ${mark(entry.maxCompletionTokens.ok)}`);

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
const agentCapable = Object.entries(report.models).filter(([, entry]) => entry.tools?.calledTool);
if (agentCapable.length > 0) {
	console.log(`Usable as pi's main model (function calling works): ${agentCapable.map(([id]) => id).join(", ")}`);
} else {
	console.log("No model emitted a tool call. These models cannot drive pi's agent loop;");
	console.log("use them through the hetzner_ask delegation tool instead (/hetzner ask on).");
}
const vision = Object.entries(report.models).filter(([, entry]) => entry.image?.ok);
console.log(`Accepts base64 images: ${vision.length > 0 ? vision.map(([id]) => id).join(", ") : "none"}`);
const reasoning = Object.entries(report.models).filter(([, entry]) => entry.chat?.reasoningContent);
console.log(`Returns reasoning_content: ${reasoning.length > 0 ? reasoning.map(([id]) => id).join(", ") : "none"}`);
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
