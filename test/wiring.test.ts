import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { recordRateLimitHeaders } from "../src/index.ts";
import { mergeCatalog } from "../src/catalog.ts";
import { loadConfig } from "../src/config.ts";
import { applyCatalog, registerProvider } from "../src/provider.ts";
import { createState } from "../src/state.ts";

const cleanState = () => createState(loadConfig({ path: "/does-not-exist", env: {} }));

test("session-start refresh is non-blocking and non-Hetzner delegation notice is one-time", () => {
	const previous = { ask: process.env.PI_HETZNER_ASK, quiet: process.env.PI_HETZNER_QUIET, discovery: process.env.PI_HETZNER_DISCOVERY };
	process.env.PI_HETZNER_ASK = "true";
	process.env.PI_HETZNER_QUIET = "false";
	process.env.PI_HETZNER_DISCOVERY = "false";
	try {
		const handlers = new Map<string, Function>();
		const notices: string[] = [];
		const providers: string[] = [];
		const commands: string[] = [];
		const tools: string[] = [];
		const pi = {
			registerProvider(name: string) { providers.push(name); },
			registerCommand(name: string) { commands.push(name); },
			registerTool(tool: { name: string }) { tools.push(tool.name); },
			on(name: string, handler: Function) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI;
		extension(pi);
		assert.deepEqual(providers, ["hetzner"]);
		assert.deepEqual(commands, ["hetzner"]);
		assert.deepEqual(tools, ["hetzner_ask"]);
		assert.deepEqual([...handlers.keys()], [
			"session_start", "model_select", "turn_end", "after_provider_response", "session_shutdown",
		]);
		const ctx = {
			model: { provider: "other" },
			modelRegistry: { getApiKeyForProvider: () => new Promise<string>(() => {}) },
			ui: { notify: (message: string) => notices.push(message), setStatus() {} },
		};
		assert.equal(handlers.get("session_start")?.({}, ctx), undefined);
		handlers.get("model_select")?.({}, ctx);
		assert.equal(notices.length, 1);
		assert.match(notices[0]!, /may be sent to Hetzner/);
	} finally {
		for (const [name, value] of Object.entries({
			PI_HETZNER_ASK: previous.ask,
			PI_HETZNER_QUIET: previous.quiet,
			PI_HETZNER_DISCOVERY: previous.discovery,
		})) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("session shutdown prevents a pending background refresh from publishing", async () => {
	const previous = process.env.PI_HETZNER_DISCOVERY;
	process.env.PI_HETZNER_DISCOVERY = "true";
	try {
		const handlers = new Map<string, Function>();
		let registrations = 0;
		let resolveCredential!: (value: string) => void;
		const credential = new Promise<string>((resolve) => { resolveCredential = resolve; });
		const pi = {
			registerProvider() { registrations++; }, registerCommand() {}, registerTool() {},
			on(name: string, handler: Function) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI;
		extension(pi);
		const ctx = {
			model: { provider: "other" },
			modelRegistry: { getApiKeyForProvider: () => credential },
			ui: { notify() {}, setStatus() {} },
		};
		handlers.get("session_start")?.({}, ctx);
		handlers.get("session_shutdown")?.({}, ctx);
		resolveCredential("secret");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(registrations, 1);
	} finally {
		if (previous === undefined) delete process.env.PI_HETZNER_DISCOVERY;
		else process.env.PI_HETZNER_DISCOVERY = previous;
	}
});

test("429 responses notify and session shutdown clears host status", () => {
	const previous = {
		discovery: process.env.PI_HETZNER_DISCOVERY,
		quiet: process.env.PI_HETZNER_QUIET,
	};
	process.env.PI_HETZNER_DISCOVERY = "false";
	process.env.PI_HETZNER_QUIET = "true";
	try {
		const handlers = new Map<string, Function>();
		const notices: string[] = [];
		const statuses: unknown[][] = [];
		const pi = {
			registerProvider() {}, registerCommand() {},
			on(name: string, handler: Function) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI;
		extension(pi);
		const ctx = {
			model: { provider: "hetzner" },
			ui: {
				notify(message: string) { notices.push(message); },
				setStatus(...args: unknown[]) { statuses.push(args); },
			},
		};
		handlers.get("after_provider_response")?.({ status: 429, headers: { "retry-after": "4" } }, ctx);
		assert.match(notices[0]!, /retry after 4s/);
		handlers.get("session_shutdown")?.({}, ctx);
		assert.deepEqual(statuses.at(-1), ["hetzner-budget", undefined]);
	} finally {
		if (previous.discovery === undefined) delete process.env.PI_HETZNER_DISCOVERY;
		else process.env.PI_HETZNER_DISCOVERY = previous.discovery;
		if (previous.quiet === undefined) delete process.env.PI_HETZNER_QUIET;
		else process.env.PI_HETZNER_QUIET = previous.quiet;
	}
});

test("latest provider response clears stale rate-limit headers", () => {
	const state = cleanState();
	recordRateLimitHeaders(state, { "x-ratelimit-remaining": "3" });
	assert.deepEqual(state.serverHeaders, { "x-ratelimit-remaining": "3" });
	recordRateLimitHeaders(state, {});
	assert.deepEqual(state.serverHeaders, {});
});

test("failed provider refresh keeps the last-known catalog", async () => {
	const state = cleanState();
	const before = state.models.map((model) => model.id);
	let config: any;
	registerProvider({ registerProvider(_id: string, value: unknown) { config = value; } } as unknown as ExtensionAPI, state);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error("temporary outage"); };
	try {
		await assert.rejects(config.refreshModels({
			credential: { type: "api_key", key: "secret" },
			allowNetwork: true,
			force: true,
			signal: new AbortController().signal,
			publish: async () => true,
		}), /temporary outage/);
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.deepEqual(state.models.map((model) => model.id), before);
	assert.equal(state.discoveryError, "temporary outage");
});

test("successful provider refresh updates extension state through transactional publication", async () => {
	const state = cleanState();
	let config: any;
	registerProvider({ registerProvider(_id: string, value: unknown) { config = value; } } as unknown as ExtensionAPI, state);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "GLM-5.2-NVFP4" }] }));
	let publications = 0;
	try {
		const models = await config.refreshModels({
			credential: { type: "api_key", key: "secret" },
			allowNetwork: true,
			force: true,
			signal: new AbortController().signal,
			publish: async ({ update }: { update?: () => void }) => {
				publications++;
				update?.();
				return true;
			},
		});
		assert.deepEqual(models.map((model: { id: string }) => model.id), ["GLM-5.2-NVFP4"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.equal(publications, 1);
	assert.deepEqual(state.models.map((model) => model.id), ["GLM-5.2-NVFP4"]);
	assert.equal(state.source, "network");
});

test("catalog application avoids unchanged re-registration and reports changed ids", () => {
	const state = cleanState();
	let registrations = 0;
	const pi = { registerProvider() { registrations++; } } as unknown as ExtensionAPI;
	const same = { ...mergeCatalog([], state.config), source: "static" as const, ids: [] };
	assert.equal(applyCatalog(pi, state, same), undefined);
	assert.equal(registrations, 0);
	const removed = state.models.filter((model) => model.id !== "GLM-5.2-NVFP4").map((model) => model.id);
	const changed = { ...mergeCatalog(["GLM-5.2-NVFP4"], state.config), source: "network" as const, ids: ["GLM-5.2-NVFP4"] };
	assert.deepEqual(applyCatalog(pi, state, changed), { added: [], removed });
	assert.equal(registrations, 1);
});
