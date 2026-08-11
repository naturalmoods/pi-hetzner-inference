/**
 * Extension settings.
 *
 * Resolution order: environment variable > config file > default. The config
 * file is `~/.pi/agent/hetzner-inference.json` and is the only thing this
 * extension writes; API tokens live in pi's own credential store, never here.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_TOKENS } from "./catalog.ts";

export interface HetznerConfig {
	/** Suppress the one-time experiment notice. */
	quiet: boolean;
	/** Allow `/v1/models` lookups. Off means static catalog only. */
	discovery: boolean;
	/** Hours before a stored catalog is refreshed from the network. */
	discoveryTtlHours: number;
	/** Show the rate-limit budget in the status bar. */
	budget: boolean;
	/** Register the `hetzner_ask` delegation tool. */
	ask: boolean;
	/** Model id used by `hetzner_ask`. Empty means "first available". */
	askModel: string;
	/** Output cap advertised for every model. */
	maxTokens: number;
}

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "hetzner-inference.json");

const DEFAULTS: HetznerConfig = {
	quiet: false,
	discovery: true,
	discoveryTtlHours: 12,
	budget: true,
	// Off by default: an extra tool in every system prompt is intrusive, and it is
	// only useful when the main model is not already a Hetzner one.
	ask: false,
	askModel: "",
	maxTokens: DEFAULT_MAX_TOKENS,
};

function readFile(): Partial<HetznerConfig> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Partial<HetznerConfig>) : {};
	} catch {
		// Missing or malformed config must never break startup.
		return {};
	}
}

function envBool(name: string): boolean | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return undefined;
	return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function envNumber(name: string): number | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function loadConfig(): HetznerConfig {
	const file = readFile();
	return {
		quiet: envBool("PI_HETZNER_QUIET") ?? file.quiet ?? DEFAULTS.quiet,
		discovery: envBool("PI_HETZNER_DISCOVERY") ?? file.discovery ?? DEFAULTS.discovery,
		discoveryTtlHours:
			envNumber("PI_HETZNER_DISCOVERY_TTL_HOURS") ??
			file.discoveryTtlHours ??
			DEFAULTS.discoveryTtlHours,
		budget: envBool("PI_HETZNER_BUDGET") ?? file.budget ?? DEFAULTS.budget,
		ask: envBool("PI_HETZNER_ASK") ?? file.ask ?? DEFAULTS.ask,
		askModel: process.env.PI_HETZNER_ASK_MODEL ?? file.askModel ?? DEFAULTS.askModel,
		maxTokens: envNumber("PI_HETZNER_MAX_TOKENS") ?? file.maxTokens ?? DEFAULTS.maxTokens,
	};
}

/** Persist a single setting. Returns false when the file cannot be written. */
export function saveSetting<K extends keyof HetznerConfig>(key: K, value: HetznerConfig[K]): boolean {
	try {
		const next = { ...readFile(), [key]: value };
		writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}
