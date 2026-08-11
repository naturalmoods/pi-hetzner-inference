/**
 * `hetzner_ask` — delegate self-contained bulk text work to a free model.
 *
 * Opt-in (`/hetzner ask on` or `PI_HETZNER_ASK=1`). It is useful when the main
 * model is an expensive one: summarising logs, translating, extracting fields
 * from large dumps. The delegate gets no tools and no repository access, so
 * everything it needs must be in `input`.
 *
 * Thinking is switched off where the model has a measured switch: this work is
 * mechanical, and reasoning is billed against the same per-key output budget the
 * main model is spending.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BASE_URL, PROVIDER_ID, thinkingOffKwargs } from "./catalog.ts";
import type { State } from "./state.ts";

const REQUEST_TIMEOUT_MS = 180_000;

interface CompletionResponse {
	choices?: { message?: { content?: string }; finish_reason?: string }[];
	usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function registerAskTool(pi: ExtensionAPI, state: State): void {
	pi.registerTool({
		name: "hetzner_ask",
		label: "Hetzner Ask",
		description:
			"Ask a free Hetzner-hosted model to process text you provide. The delegate has no tools, " +
			"no repository access and no conversation history: everything it needs must be in `input`. " +
			"Returns its reply as text.",
		promptSnippet: "hetzner_ask: delegate bulk text work (summarise, translate, extract) to a free model",
		promptGuidelines: [
			"Use hetzner_ask for large-input, low-stakes text work: summarising logs or diffs, translating, extracting fields.",
			"Do not use hetzner_ask for judgements about code correctness, or for anything that needs repository context.",
			"Pass the full text in `input` — the delegate sees nothing else.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "What the delegate should do with the input" }),
			input: Type.String({ description: "The text to process" }),
			model: Type.Optional(Type.String({ description: "Hetzner model id; defaults to the configured one" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
			if (!token) {
				throw new Error("No Hetzner API token configured. Run /login hetzner.");
			}

			const model = params.model || state.config.askModel || state.models[0]?.id;
			if (!model) throw new Error("No Hetzner model available.");

			// Every model here reasons unprompted and bills for it. The delegate is
			// summarising and extracting, so that reasoning is discarded — switch it
			// off where a switch has been measured, and leave the request alone where
			// one has not, since an unrecognised key is accepted and ignored.
			const thinkingOff = thinkingOffKwargs(model);

			const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const response = await fetch(`${BASE_URL}/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					max_tokens: state.config.maxTokens,
					...(thinkingOff ? { chat_template_kwargs: thinkingOff } : {}),
					messages: [
						{
							role: "system",
							content:
								"You process the text the user provides and nothing else. " +
								"Answer directly, without preamble, and do not ask follow-up questions.",
						},
						{ role: "user", content: `${params.task}\n\n---\n${params.input}` },
					],
				}),
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});

			if (!response.ok) {
				const body = await response.text().catch(() => "");
				throw new Error(`Hetzner ${model} returned HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
			}

			const payload = (await response.json()) as CompletionResponse;
			const text = payload.choices?.[0]?.message?.content?.trim();
			if (!text) throw new Error(`Hetzner ${model} returned an empty response.`);

			// The delegate spends the same per-key budget as the main model.
			const usage = {
				input: payload.usage?.prompt_tokens ?? 0,
				output: payload.usage?.completion_tokens ?? 0,
			};
			state.window.add({ at: Date.now(), ...usage });

			return {
				content: [{ type: "text" as const, text }],
				details: {
					model,
					usage,
					finishReason: payload.choices?.[0]?.finish_reason,
					thinking: thinkingOff ? "off" : "not switchable",
				},
			};
		},
	});
}
