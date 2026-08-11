import assert from "node:assert/strict";
import { test } from "node:test";
import { formatStatus, formatTokens, pickRateLimitHeaders, RateWindow, retryAfterSeconds } from "../src/budget.ts";

const T0 = 1_800_000_000_000;

test("usage sums samples inside the window", () => {
	const window = new RateWindow();
	window.add({ at: T0, input: 1000, output: 100 });
	window.add({ at: T0 + 1000, input: 2000, output: 200 });

	const usage = window.usage(T0 + 2000);
	assert.equal(usage.input, 3000);
	assert.equal(usage.output, 300);
	assert.equal(usage.samples, 2);
});

test("samples older than 60s drop out", () => {
	const window = new RateWindow();
	window.add({ at: T0, input: 1000, output: 100 });
	window.add({ at: T0 + 30_000, input: 500, output: 50 });

	const usage = window.usage(T0 + 60_001);
	assert.equal(usage.input, 500);
	assert.equal(usage.samples, 1);
	// The remaining sample expires 60s after it was recorded.
	assert.equal(usage.resetInMs, 29_999);
});

test("worstFraction tracks the tighter limit", () => {
	const window = new RateWindow();
	// 1M input is 10% of the input limit; 100k output is 50% of the output limit.
	window.add({ at: T0, input: 1_000_000, output: 100_000 });
	assert.equal(window.usage(T0).worstFraction, 0.5);
});

test("empty and zero-token samples produce no status line", () => {
	const window = new RateWindow();
	assert.equal(formatStatus(window.usage(T0)), undefined);
	window.add({ at: T0, input: 0, output: 0 });
	assert.equal(window.usage(T0).samples, 0);
});

test("status line reports both budgets", () => {
	const window = new RateWindow();
	window.add({ at: T0, input: 1_200_000, output: 34_000 });
	assert.equal(formatStatus(window.usage(T0)), "hetzner in 1.2M/10M · out 34k/200k (60s)");
});

test("token formatting", () => {
	assert.equal(formatTokens(512), "512");
	assert.equal(formatTokens(34_000), "34k");
	assert.equal(formatTokens(1_200_000), "1.2M");
	assert.equal(formatTokens(10_000_000), "10M");
});

test("only rate-limit headers are picked up", () => {
	const picked = pickRateLimitHeaders({
		"Content-Type": "application/json",
		"Retry-After": "12",
		"X-RateLimit-Remaining-Tokens": "42",
		"x-request-id": "abc",
	});
	assert.deepEqual(picked, { "retry-after": "12", "x-ratelimit-remaining-tokens": "42" });
});

test("retry-after parsing prefers milliseconds", () => {
	assert.equal(retryAfterSeconds({ "retry-after": "12" }), 12);
	assert.equal(retryAfterSeconds({ "retry-after-ms": "1500", "retry-after": "12" }), 1.5);
	assert.equal(retryAfterSeconds({}), undefined);
	assert.equal(retryAfterSeconds({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }), undefined);
});
