/** Bounded, best-effort model discovery against the fixed Hetzner origin. */

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { API_KEY_ENV, BASE_URL, mergeCatalog, type MergeResult } from "./catalog.ts";

export const CACHE_PATH = join(homedir(), ".pi", "agent", "cache", "hetzner-inference-models.json");
export const MAX_DISCOVERY_BYTES = 1_000_000;
export const MAX_CATALOG_MODELS = 1_000;
export const MAX_MODEL_ID_LENGTH = 200;
const FETCH_TIMEOUT_MS = 8_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/;

interface CacheFile { ids: string[]; checkedAt: number }

export interface RefreshContext {
	credential?: { type?: string; key?: string };
	allowNetwork: boolean;
	force?: boolean;
	signal: AbortSignal;
	publish(publication: { update?: () => void }): Promise<boolean>;
}

export type CatalogSource = "network" | "cache" | "static";
export interface DiscoveryResult extends MergeResult {
	source: CatalogSource;
	ids: string[];
	checkedAt?: number;
	error?: string;
	skipReason?: string;
}

export function isValidModelId(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_MODEL_ID_LENGTH && MODEL_ID.test(value);
}

export async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(`response exceeds ${maxBytes} bytes`);
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return new TextDecoder().decode(bytes);
}

function readCache(path = CACHE_PATH): CacheFile | undefined {
	try {
		if (statSync(path).size > MAX_DISCOVERY_BYTES) return undefined;
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const { ids, checkedAt } = parsed as Partial<CacheFile>;
		if (!Array.isArray(ids) || ids.length > MAX_CATALOG_MODELS || !ids.every(isValidModelId)) return undefined;
		return { ids, checkedAt: typeof checkedAt === "number" && Number.isFinite(checkedAt) ? checkedAt : 0 };
	} catch {
		return undefined;
	}
}

function writeCache(entry: CacheFile, path = CACHE_PATH): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		chmodSync(path, 0o600);
	} catch { /* A read-only cache degrades to per-session discovery. */ }
}

export async function fetchModelIds(
	token: string,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const response = await fetchImpl(`${BASE_URL}/models`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(`GET /v1/models returned HTTP ${response.status}`);
	}
	let text: string;
	try {
		text = await readBoundedResponse(response, MAX_DISCOVERY_BYTES);
	} catch (error) {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Model discovery aborted");
		throw error;
	}
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error("GET /v1/models returned invalid JSON");
	}
	const data = (payload as { data?: unknown })?.data;
	if (!Array.isArray(data) || data.length > MAX_CATALOG_MODELS) {
		throw new Error("GET /v1/models returned an unexpected catalog");
	}
	const ids = data.map((entry) => (entry as { id?: unknown })?.id);
	if (!ids.every(isValidModelId)) throw new Error("GET /v1/models returned an invalid model id");
	return ids;
}

export interface DiscoverOptions {
	token?: string;
	allowNetwork: boolean;
	discovery?: boolean;
	force?: boolean;
	ttlHours: number;
	maxTokens: number;
	signal?: AbortSignal;
	now?: number;
	cachePath?: string;
	fetchImpl?: typeof fetch;
}

export async function discoverCatalog(options: DiscoverOptions): Promise<DiscoveryResult> {
	if (options.signal?.aborted) {
		throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Model discovery aborted");
	}
	if (options.discovery === false) {
		return { ...mergeCatalog([], options), source: "static", ids: [], skipReason: "discovery disabled" };
	}
	const now = options.now ?? Date.now();
	const cache = readCache(options.cachePath);
	const fresh =
		cache !== undefined && cache.checkedAt <= now && now - cache.checkedAt < options.ttlHours * 3_600_000;
	const fromCache = (fields: Pick<DiscoveryResult, "error" | "skipReason"> = {}): DiscoveryResult =>
		cache
			? { ...mergeCatalog(cache.ids, options), source: "cache", ids: cache.ids, checkedAt: cache.checkedAt, ...fields }
			: { ...mergeCatalog([], options), source: "static", ids: [], ...fields };

	if (!options.token) return fromCache({ skipReason: "no API token configured" });
	if (!options.allowNetwork) return fromCache({ skipReason: "network access not allowed" });
	if (fresh && !options.force) return fromCache({ skipReason: "cache is fresh" });

	try {
		const ids = await fetchModelIds(options.token, options.signal, options.fetchImpl);
		if (ids.length === 0) throw new Error("GET /v1/models returned no models");
		writeCache({ ids, checkedAt: now }, options.cachePath);
		return { ...mergeCatalog(ids, options), source: "network", ids, checkedAt: now };
	} catch (error) {
		if (options.signal?.aborted) {
			throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Model discovery aborted");
		}
		return fromCache({ error: error instanceof Error ? error.message : String(error) });
	}
}

export function tokenFromContext(context: RefreshContext): string | undefined {
	return context.credential?.key || process.env[API_KEY_ENV] || undefined;
}
