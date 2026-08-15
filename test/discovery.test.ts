import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	discoverCatalog,
	fetchModelIds,
	MAX_CATALOG_MODELS,
	MAX_DISCOVERY_BYTES,
	MAX_MODEL_ID_LENGTH,
	readBoundedResponse,
} from "../src/discovery.ts";
import { KNOWN_MODELS } from "../src/catalog.ts";

function response(body: string, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(body, { status, headers });
}

function cache(ids: string[], checkedAt = Date.now()): string {
	const path = join(mkdtempSync(join(tmpdir(), "hetzner-cache-")), "cache.json");
	writeFileSync(path, JSON.stringify({ ids, checkedAt }));
	return path;
}

test("bounded response reading rejects declared and streamed oversized bodies", async () => {
	await assert.rejects(readBoundedResponse(response("x", 200, { "content-length": "11" }), 10), /exceeds/);
	await assert.rejects(readBoundedResponse(response("x".repeat(11)), 10), /exceeds/);
});

test("discovery rejects oversized catalogs, long ids, and control characters", async () => {
	const cases = [
		{ data: Array.from({ length: MAX_CATALOG_MODELS + 1 }, (_, id) => ({ id: `m${id}` })) },
		{ data: [{ id: "x".repeat(MAX_MODEL_ID_LENGTH + 1) }] },
		{ data: [{ id: "safe\nspoof" }] },
	];
	for (const body of cases) {
		await assert.rejects(fetchModelIds("secret", undefined, async () => response(JSON.stringify(body))), /catalog|model id/);
	}
});

test("discovery rejects an oversized response before parsing", async () => {
	await assert.rejects(
		fetchModelIds("secret", undefined, async () => response("{}", 200, { "content-length": String(MAX_DISCOVERY_BYTES + 1) })),
		/exceeds/,
	);
});

test("malformed discovery JSON does not expose response fragments", async () => {
	const secret = "server-echoed-secret";
	await assert.rejects(
		fetchModelIds("token", undefined, async () => response(`{\"data\":${secret}`)),
		(error: Error) => error.message === "GET /v1/models returned invalid JSON" && !error.message.includes(secret),
	);
});

test("oversized cache files are ignored and fall back to the static catalog", async () => {
	const path = cache(["Cached-Model"]);
	writeFileSync(path, " ".repeat(MAX_DISCOVERY_BYTES + 1));
	const result = await discoverCatalog({ allowNetwork: false, cachePath: path, ttlHours: 12, maxTokens: 4096 });
	assert.equal(result.source, "static");
	assert.equal(result.models.length, KNOWN_MODELS.length);
});

test("discovery=false ignores a populated cache and uses the static catalog", async () => {
	const result = await discoverCatalog({
		discovery: false, allowNetwork: true, token: "secret", cachePath: cache(["Cached-Model"]), ttlHours: 12, maxTokens: 4096,
		fetchImpl: async () => { throw new Error("must not fetch"); },
	});
	assert.equal(result.source, "static");
	assert.equal(result.skipReason, "discovery disabled");
	assert.equal(result.error, undefined);
	assert.equal(result.models.length, KNOWN_MODELS.length);
});

test("no-token and offline paths are expected skips, while transport failures are errors", async () => {
	const common = { ttlHours: 12, maxTokens: 4096, cachePath: cache(["Cached-Model"]) };
	const noToken = await discoverCatalog({ ...common, allowNetwork: true });
	assert.equal(noToken.skipReason, "no API token configured");
	assert.equal(noToken.error, undefined);
	const offline = await discoverCatalog({ ...common, token: "secret", allowNetwork: false });
	assert.equal(offline.skipReason, "network access not allowed");
	assert.equal(offline.error, undefined);
	const failed = await discoverCatalog({
		...common, token: "secret", allowNetwork: true, force: true,
		fetchImpl: async () => { throw new Error("timed out"); },
	});
	assert.equal(failed.error, "timed out");
	assert.equal(failed.skipReason, undefined);
	assert.equal(failed.source, "cache");
});

test("caller cancellation propagates instead of publishing a fallback", async () => {
	for (const options of [
		{ allowNetwork: true },
		{ token: "secret", allowNetwork: false },
		{ token: "secret", allowNetwork: true },
	]) {
		const controller = new AbortController();
		controller.abort(new Error("cancelled by caller"));
		await assert.rejects(
			discoverCatalog({
				...options, force: true, ttlHours: 12, maxTokens: 4096, signal: controller.signal,
				fetchImpl: async () => { throw new Error("transport failure"); },
			}),
			/cancelled by caller/,
		);
	}
});

test("successful discovery repairs permissions on an existing cache file", async () => {
	const path = cache(["Cached-Model"], 0);
	chmodSync(path, 0o644);
	await discoverCatalog({
		token: "secret", allowNetwork: true, force: true, ttlHours: 12, maxTokens: 4096, cachePath: path,
		fetchImpl: async () => response(JSON.stringify({ data: [{ id: "Kimi-K2.7-Code" }] })),
	});
	assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("future cache timestamps do not suppress a network refresh", async () => {
	let fetched = false;
	const result = await discoverCatalog({
		token: "secret", allowNetwork: true, ttlHours: 12, maxTokens: 4096,
		now: 1_000, cachePath: cache(["Cached-Model"], 2_000),
		fetchImpl: async () => {
			fetched = true;
			return response(JSON.stringify({ data: [{ id: "Kimi-K2.7-Code" }] }));
		},
	});
	assert.equal(fetched, true);
	assert.equal(result.source, "network");
});
