/**
 * Model discovery against `GET /v1/models`.
 *
 * Only the reported ids are cached — metadata always comes from `catalog.ts`,
 * so updating this package immediately improves an existing cache instead of
 * being shadowed by it. Discovery never throws: on any failure the cached ids
 * (or the static catalog) are used, and the reason is reported to the caller.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { API_KEY_ENV, BASE_URL, mergeCatalog, type MergeResult } from "./catalog.ts";

export const CACHE_PATH = join(homedir(), ".pi", "agent", "cache", "hetzner-inference-models.json");

const FETCH_TIMEOUT_MS = 8_000;

interface CacheFile {
	ids: string[];
	checkedAt: number;
}

/**
 * Structural subset of pi-ai's `RefreshModelsContext`.
 *
 * Declared locally so this package needs no runtime dependency on `@earendil-works/pi-ai`,
 * which is not resolvable from an installed pi package.
 */
export interface RefreshContext {
	credential?: { type?: string; key?: string };
	allowNetwork: boolean;
	force?: boolean;
	signal?: AbortSignal;
}

export type CatalogSource = "network" | "cache" | "static";

export interface DiscoveryResult extends MergeResult {
	source: CatalogSource;
	/** Reported ids behind this result, for cache writes and `/hetzner status`. */
	ids: string[];
	checkedAt?: number;
	error?: string;
}

function readCache(): CacheFile | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const { ids, checkedAt } = parsed as Partial<CacheFile>;
		if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return undefined;
		return { ids, checkedAt: typeof checkedAt === "number" ? checkedAt : 0 };
	} catch {
		return undefined;
	}
}

function writeCache(entry: CacheFile): void {
	try {
		mkdirSync(dirname(CACHE_PATH), { recursive: true });
		writeFileSync(CACHE_PATH, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
	} catch {
		// A read-only cache location degrades to per-session discovery, not an error.
	}
}

/** Fetch the reported model ids. Rejects on transport, auth or shape problems. */
export async function fetchModelIds(token: string, signal?: AbortSignal): Promise<string[]> {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const response = await fetch(`${BASE_URL}/models`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) {
		throw new Error(`GET /v1/models returned HTTP ${response.status}`);
	}
	const payload: unknown = await response.json();
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data)) {
		throw new Error("GET /v1/models returned an unexpected body");
	}
	return data
		.map((entry) => (entry as { id?: unknown }).id)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
}

export interface DiscoverOptions {
	token?: string;
	allowNetwork: boolean;
	force?: boolean;
	ttlHours: number;
	maxTokens: number;
	signal?: AbortSignal;
	now?: number;
}

/** Resolve the catalog from the network, the cache, or the static table. */
export async function discoverCatalog(options: DiscoverOptions): Promise<DiscoveryResult> {
	const now = options.now ?? Date.now();
	const cache = readCache();
	const fresh = cache !== undefined && now - cache.checkedAt < options.ttlHours * 3_600_000;

	const fromCache = (error?: string): DiscoveryResult =>
		cache
			? { ...mergeCatalog(cache.ids, options), source: "cache", ids: cache.ids, checkedAt: cache.checkedAt, error }
			: { ...mergeCatalog([], options), source: "static", ids: [], error };

	if (!options.token) return fromCache("no API token configured");
	if (!options.allowNetwork) return fromCache("network access not allowed");
	if (fresh && !options.force) return fromCache();

	try {
		const ids = await fetchModelIds(options.token, options.signal);
		if (ids.length === 0) throw new Error("GET /v1/models returned no models");
		writeCache({ ids, checkedAt: now });
		return { ...mergeCatalog(ids, options), source: "network", ids, checkedAt: now };
	} catch (error) {
		return fromCache(error instanceof Error ? error.message : String(error));
	}
}

/** Token for our own requests: pi's stored credential first, then the environment. */
export function tokenFromContext(context: RefreshContext): string | undefined {
	return context.credential?.key || process.env[API_KEY_ENV] || undefined;
}
