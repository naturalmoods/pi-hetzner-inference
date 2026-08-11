/**
 * Provider registration.
 *
 * The legacy `registerProvider(name, config)` form is deliberate: pi composes it
 * into a full provider that already supplies an API-key login (`/login hetzner`,
 * secret prompt, stored in `auth.json`), falls back to the environment variable,
 * reports the provider as unconfigured when neither is present, and streams
 * through pi's own `openai-completions` implementation — including the built-in
 * HTTP 429 retry that honours `Retry-After`. None of that needs reimplementing.
 */

import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { API_KEY_ENV, BASE_URL, PROVIDER_ID, PROVIDER_NAME } from "./catalog.ts";
import { discoverCatalog, tokenFromContext, type DiscoveryResult, type RefreshContext } from "./discovery.ts";
import type { State } from "./state.ts";

function providerConfig(state: State, models: ProviderModelConfig[]): ProviderConfig {
	return {
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		// A stored credential takes precedence over this; an unset variable simply
		// leaves the provider unconfigured rather than throwing at startup.
		apiKey: `$${API_KEY_ENV}`,
		api: "openai-completions",
		models,
		// Called by `pi update models` and by pi's own catalog refresh. Runs with
		// `allowNetwork: false` during offline initialisation.
		refreshModels: async (context: RefreshContext) => {
			const result = await discoverCatalog({
				token: tokenFromContext(context),
				allowNetwork: context.allowNetwork && state.config.discovery,
				force: context.force,
				ttlHours: state.config.discoveryTtlHours,
				maxTokens: state.config.maxTokens,
				signal: context.signal,
			});
			recordCatalog(state, result);
			return result.models;
		},
	};
}

/** Store a discovery result without touching the registry. */
export function recordCatalog(state: State, result: DiscoveryResult): void {
	state.models = result.models;
	state.ids = result.ids;
	state.source = result.source;
	state.checkedAt = result.checkedAt;
	state.discoveryError = result.error;
}

export function registerProvider(pi: ExtensionAPI, state: State): void {
	pi.registerProvider(PROVIDER_ID, providerConfig(state, state.models));
}

export interface CatalogChange {
	added: string[];
	removed: string[];
}

/**
 * Publish a discovery result to the registry.
 *
 * Re-registration after the initial load phase applies immediately, so no
 * `/reload` is needed. Returns the id-level diff for reporting, or undefined
 * when nothing changed.
 */
export function applyCatalog(pi: ExtensionAPI, state: State, result: DiscoveryResult): CatalogChange | undefined {
	const before = new Set(state.models.map((model) => model.id));
	recordCatalog(state, result);
	const after = new Set(state.models.map((model) => model.id));

	const added = [...after].filter((id) => !before.has(id));
	const removed = [...before].filter((id) => !after.has(id));
	pi.registerProvider(PROVIDER_ID, providerConfig(state, state.models));
	return added.length > 0 || removed.length > 0 ? { added, removed } : undefined;
}
