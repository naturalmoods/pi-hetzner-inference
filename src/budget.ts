/**
 * Rate-limit visibility.
 *
 * The documented limits are per API key over a 60 second window: 10M input and
 * 200k output tokens. pi already retries HTTP 429 with the server's
 * `Retry-After`, so this module does not retry anything — it exists so the user
 * can see how close they are before a turn stalls, and why it stalled.
 *
 * Token counts come from assistant-message usage, which means the window
 * reflects what pi observed in this session only. Requests made by other
 * clients with the same key are invisible here.
 */

import { RATE_LIMITS } from "./catalog.ts";

export interface UsageSample {
	at: number;
	input: number;
	output: number;
}

export interface WindowUsage {
	input: number;
	output: number;
	/** Fraction of the tighter of the two limits, 0..n. */
	worstFraction: number;
	/** Milliseconds until the oldest sample leaves the window, 0 when empty. */
	resetInMs: number;
	samples: number;
}

export class RateWindow {
	private samples: UsageSample[] = [];

	add(sample: UsageSample): void {
		if (sample.input <= 0 && sample.output <= 0) return;
		this.samples.push(sample);
		this.prune(sample.at);
	}

	private prune(now: number): void {
		const cutoff = now - RATE_LIMITS.windowMs;
		if (this.samples.length > 0 && this.samples[0]!.at <= cutoff) {
			this.samples = this.samples.filter((sample) => sample.at > cutoff);
		}
	}

	usage(now: number): WindowUsage {
		this.prune(now);
		let input = 0;
		let output = 0;
		for (const sample of this.samples) {
			input += sample.input;
			output += sample.output;
		}
		const oldest = this.samples[0];
		return {
			input,
			output,
			worstFraction: Math.max(input / RATE_LIMITS.inputTokens, output / RATE_LIMITS.outputTokens),
			resetInMs: oldest ? Math.max(0, oldest.at + RATE_LIMITS.windowMs - now) : 0,
			samples: this.samples.length,
		};
	}

	clear(): void {
		this.samples = [];
	}
}

export function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`;
	if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
	return String(count);
}

/** Status-bar text, e.g. `hetzner in 1.2M/10M · out 34k/200k (60s)`. */
export function formatStatus(usage: WindowUsage): string | undefined {
	if (usage.samples === 0) return undefined;
	return (
		`hetzner in ${formatTokens(usage.input)}/${formatTokens(RATE_LIMITS.inputTokens)}` +
		` · out ${formatTokens(usage.output)}/${formatTokens(RATE_LIMITS.outputTokens)} (60s)`
	);
}

/** Rate-limit related response headers, if the deployment sends any. */
export function pickRateLimitHeaders(headers: Record<string, string>): Record<string, string> {
	const picked: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (/^(x-)?ratelimit|^retry-after(-ms)?$/i.test(name)) picked[name.toLowerCase()] = value;
	}
	return picked;
}

export function retryAfterSeconds(headers: Record<string, string>): number | undefined {
	const ms = headers["retry-after-ms"];
	if (ms && Number.isFinite(Number(ms))) return Number(ms) / 1000;
	const seconds = headers["retry-after"];
	if (seconds && Number.isFinite(Number(seconds))) return Number(seconds);
	return undefined;
}
