/**
 * pi-hetzner-inference
 *
 * Registers the Hetzner Experiments Platform Inference API as a pi provider,
 * keeps its model catalog in sync with `/v1/models`, and makes the per-key rate
 * limits visible.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatStatus, pickRateLimitHeaders, retryAfterSeconds } from "./budget.ts";
import { PROVIDER_ID } from "./catalog.ts";
import { registerCommands } from "./commands.ts";
import { registerAskTool } from "./delegate.ts";
import { discoverCatalog } from "./discovery.ts";
import { applyCatalog, registerProvider } from "./provider.ts";
import { createState, type State } from "./state.ts";

const STATUS_KEY = "hetzner-budget";

const NOTICE = [
	"Hetzner Inference is an experiment, not a product: no SLA, no guaranteed availability,",
	"and it can be changed or withdrawn at any time. Public documentation describes metric collection",
	"but does not specify prompt, completion, or image retention. Avoid sensitive or production-critical data.",
	"Silence this with /hetzner quiet.",
].join(" ");

const DELEGATION_NOTICE =
	"hetzner_ask is active: content supplied to the tool may be sent to Hetzner; public documentation does not " +
	"specify content retention. Delegate output is untrusted text. Silence this with /hetzner quiet.";

/** Warn at most once per rolling window so a long turn does not spam. */
const WARN_THRESHOLD = 0.8;
const WARN_COOLDOWN_MS = 60_000;

export function recordRateLimitHeaders(state: State, headers: Record<string, string>): Record<string, string> {
	return (state.serverHeaders = pickRateLimitHeaders(headers));
}

export default function (pi: ExtensionAPI): void {
	const state = createState();

	registerProvider(pi, state);
	registerCommands(pi, state);
	if (state.config.ask) registerAskTool(pi, state);

	const isActive = (ctx: ExtensionContext): boolean => ctx.model?.provider === PROVIDER_ID;

	const showNotice = (ctx: ExtensionContext): void => {
		if (state.noticeShown || (!isActive(ctx) && !state.config.ask)) return;
		state.noticeShown = true;
		ctx.ui.notify(isActive(ctx) ? NOTICE : DELEGATION_NOTICE, "warning");
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		if (!state.config.budget) return;
		if (!isActive(ctx)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, formatStatus(state.window.usage(Date.now())));
	};

	/**
	 * Keep the catalog current even if pi never calls `refreshModels` on its own.
	 * Cheap by construction: a fresh cache short-circuits before any network call.
	 */
	const backgroundRefresh = async (ctx: ExtensionContext): Promise<void> => {
		if (!state.config.discovery || state.refreshing) return;
		state.refreshing = true;
		const controller = new AbortController();
		state.refreshController = controller;
		try {
			const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
			controller.signal.throwIfAborted();
			const result = await discoverCatalog({
				token,
				allowNetwork: true,
				ttlHours: state.config.discoveryTtlHours,
				maxTokens: state.config.maxTokens,
				signal: controller.signal,
			});
			controller.signal.throwIfAborted();
			if (result.error) {
				state.discoveryError = result.error;
				state.discoverySkipReason = undefined;
				return;
			}
			const change = applyCatalog(pi, state, result);
			if (change && (change.added.length > 0 || change.removed.length > 0)) {
				const parts: string[] = [];
				if (change.added.length > 0) parts.push(`new: ${change.added.join(", ")}`);
				if (change.removed.length > 0) parts.push(`gone: ${change.removed.join(", ")}`);
				ctx.ui.notify(`Hetzner model catalog changed (${parts.join("; ")}).`, "info");
			}
		} catch {
			// Cancellation and discovery failures leave the last-known catalog intact.
		} finally {
			state.refreshing = false;
			state.refreshController = undefined;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		showNotice(ctx);
		updateStatus(ctx);
		void backgroundRefresh(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		showNotice(ctx);
		updateStatus(ctx);
	});

	let lastWarnAt = 0;
	pi.on("turn_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.provider !== PROVIDER_ID) return;

		const now = Date.now();
		// Cached input still counts against the input limit, so fold it in.
		state.window.add({
			at: now,
			input: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
			output: message.usage.output,
		});
		updateStatus(ctx);

		const usage = state.window.usage(now);
		if (usage.worstFraction >= WARN_THRESHOLD && now - lastWarnAt > WARN_COOLDOWN_MS) {
			lastWarnAt = now;
			ctx.ui.notify(
				`Hetzner rate-limit window ${Math.round(usage.worstFraction * 100)}% used; ` +
					`it frees up in ${Math.ceil(usage.resetInMs / 1000)}s.`,
				"warning",
			);
		}
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (!isActive(ctx)) return;

		const headers = recordRateLimitHeaders(state, event.headers);
		if (event.status !== 429) return;

		state.last429At = Date.now();
		state.lastRetryAfterSeconds = retryAfterSeconds(headers);
		const wait = state.lastRetryAfterSeconds;
		ctx.ui.notify(
			`Hetzner rate limit (429)${wait ? `, retry after ${wait}s` : ""}. ` +
				"pi retries automatically. Limits are 10M input / 200k output tokens per 60s per key.",
			"warning",
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		state.refreshController?.abort();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
