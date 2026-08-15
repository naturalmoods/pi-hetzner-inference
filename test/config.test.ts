import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, MAX_CONFIG_BYTES, parseEnvBool, saveSetting, validateConfig } from "../src/config.ts";

function configFile(value: unknown): string {
	const path = join(mkdtempSync(join(tmpdir(), "hetzner-config-")), "config.json");
	writeFileSync(path, JSON.stringify(value));
	return path;
}

test("config validation rejects arrays, wrong types, and non-positive or non-finite numbers", () => {
	assert.deepEqual(validateConfig([]), {});
	assert.deepEqual(validateConfig({ quiet: "false", discovery: 1, discoveryTtlHours: "bad", maxTokens: -1 }), {});
	assert.deepEqual(validateConfig({ maxTokens: 2048.5 }), {});
	assert.deepEqual(validateConfig({ quiet: false, discovery: true, discoveryTtlHours: 2, maxTokens: 4096, askModel: "Kimi" }), {
		quiet: false, discovery: true, discoveryTtlHours: 2, maxTokens: 4096, askModel: "Kimi",
	});
});

test("explicit environment booleans are parsed and unknown text is ignored", () => {
	for (const value of ["1", "true", "yes", "on"]) assert.equal(parseEnvBool(value), true);
	for (const value of ["0", "false", "no", "off"]) assert.equal(parseEnvBool(value), false);
	assert.equal(parseEnvBool("definitely"), undefined);
});

test("valid environment values override file values; invalid values fall through safely", () => {
	const path = configFile({ quiet: false, discovery: false, discoveryTtlHours: 4, maxTokens: 8192, ask: true });
	const config = loadConfig({ path, env: {
		PI_HETZNER_QUIET: "true",
		PI_HETZNER_DISCOVERY: "unknown",
		PI_HETZNER_DISCOVERY_TTL_HOURS: "bad",
		PI_HETZNER_MAX_TOKENS: "NaN",
	} });
	assert.equal(config.quiet, true);
	assert.equal(config.discovery, false);
	assert.equal(config.discoveryTtlHours, 4);
	assert.equal(config.maxTokens, 8192);
	assert.equal(config.ask, true);
	assert.ok(Number.isFinite(config.maxTokens));
});

test("malformed JSON shapes use defaults without enabling notice suppression", () => {
	for (const value of [null, [], "text", { quiet: "false", ask: "true" }]) {
		const config = loadConfig({ path: configFile(value), env: {} });
		assert.equal(config.quiet, false);
		assert.equal(config.ask, false);
	}
});

test("oversized config and fractional maxTokens fall back without blocking startup", () => {
	const path = configFile({});
	writeFileSync(path, " ".repeat(MAX_CONFIG_BYTES + 1));
	assert.equal(loadConfig({ path, env: {} }).maxTokens, 32_768);
	assert.equal(loadConfig({ path: "/does-not-exist", env: { PI_HETZNER_MAX_TOKENS: "2048.5" } }).maxTokens, 32_768);
});

test("saving a setting repairs permissions on an existing config file", () => {
	const path = configFile({ quiet: false });
	chmodSync(path, 0o644);
	assert.equal(saveSetting("quiet", true, path), true);
	assert.equal(statSync(path).mode & 0o777, 0o600);
});
