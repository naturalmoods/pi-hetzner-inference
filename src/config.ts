/** Extension settings. Environment variable > config file > default. */

import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_TOKENS } from "./catalog.ts";

export interface HetznerConfig {
	quiet: boolean;
	discovery: boolean;
	discoveryTtlHours: number;
	budget: boolean;
	ask: boolean;
	askModel: string;
	maxTokens: number;
}

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "hetzner-inference.json");
export const MAX_CONFIG_BYTES = 64_000;

const DEFAULTS: HetznerConfig = {
	quiet: false,
	discovery: true,
	discoveryTtlHours: 12,
	budget: true,
	ask: false,
	askModel: "",
	maxTokens: DEFAULT_MAX_TOKENS,
};

/** Keep only correctly typed settings from an untrusted JSON document. */
export function validateConfig(value: unknown): Partial<HetznerConfig> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const source = value as Record<string, unknown>;
	const result: Partial<HetznerConfig> = {};
	for (const key of ["quiet", "discovery", "budget", "ask"] as const) {
		if (typeof source[key] === "boolean") result[key] = source[key];
	}
	const ttl = source.discoveryTtlHours;
	if (typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0) result.discoveryTtlHours = ttl;
	const maxTokens = source.maxTokens;
	if (typeof maxTokens === "number" && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
		result.maxTokens = maxTokens;
	}
	if (typeof source.askModel === "string") result.askModel = source.askModel;
	return result;
}

function readFile(path = CONFIG_PATH): Partial<HetznerConfig> {
	try {
		if (statSync(path).size > MAX_CONFIG_BYTES) return {};
		return validateConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return {};
	}
}

export function parseEnvBool(raw: string | undefined): boolean | undefined {
	if (raw === undefined || raw === "") return undefined;
	const value = raw.toLowerCase();
	if (["1", "true", "yes", "on"].includes(value)) return true;
	if (["0", "false", "no", "off"].includes(value)) return false;
	return undefined;
}

function envNumber(raw: string | undefined, integer = false): number | undefined {
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 && (!integer || Number.isSafeInteger(value)) ? value : undefined;
}

export interface LoadConfigOptions {
	path?: string;
	env?: NodeJS.ProcessEnv;
}

export function loadConfig(options: LoadConfigOptions = {}): HetznerConfig {
	const file = readFile(options.path);
	const env = options.env ?? process.env;
	return {
		quiet: parseEnvBool(env.PI_HETZNER_QUIET) ?? file.quiet ?? DEFAULTS.quiet,
		discovery: parseEnvBool(env.PI_HETZNER_DISCOVERY) ?? file.discovery ?? DEFAULTS.discovery,
		discoveryTtlHours:
			envNumber(env.PI_HETZNER_DISCOVERY_TTL_HOURS) ?? file.discoveryTtlHours ?? DEFAULTS.discoveryTtlHours,
		budget: parseEnvBool(env.PI_HETZNER_BUDGET) ?? file.budget ?? DEFAULTS.budget,
		ask: parseEnvBool(env.PI_HETZNER_ASK) ?? file.ask ?? DEFAULTS.ask,
		askModel: env.PI_HETZNER_ASK_MODEL ?? file.askModel ?? DEFAULTS.askModel,
		maxTokens: envNumber(env.PI_HETZNER_MAX_TOKENS, true) ?? file.maxTokens ?? DEFAULTS.maxTokens,
	};
}

/** Persist a single setting. Returns false when the file cannot be written. */
export function saveSetting<K extends keyof HetznerConfig>(
	key: K,
	value: HetznerConfig[K],
	path = CONFIG_PATH,
): boolean {
	try {
		const next = { ...readFile(path), [key]: value };
		writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		chmodSync(path, 0o600);
		return true;
	} catch {
		return false;
	}
}
