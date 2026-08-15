/** Shared runtime state for one pi process. */

import { RateWindow } from "./budget.ts";
import { staticCatalog } from "./catalog.ts";
import { loadConfig, type HetznerConfig } from "./config.ts";
import type { CatalogSource } from "./discovery.ts";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export interface State {
	config: HetznerConfig;
	/** Currently registered models. */
	models: ProviderModelConfig[];
	/** Model ids behind `models`; empty when they come from the static table. */
	ids: string[];
	source: CatalogSource;
	checkedAt?: number;
	/** Why the last discovery attempt failed, if it did. */
	discoveryError?: string;
	/** Expected reason discovery did not contact the network. */
	discoverySkipReason?: string;
	/** Rolling 60s token usage observed in this session. */
	window: RateWindow;
	/** Rate-limit headers from the last Hetzner response, if the API sends any. */
	serverHeaders: Record<string, string>;
	last429At?: number;
	lastRetryAfterSeconds?: number;
	/** The experiment notice is shown at most once per process. */
	noticeShown: boolean;
	/** Guards against overlapping background refreshes. */
	refreshing: boolean;
	/** Cancels the current background request during shutdown. */
	refreshController?: AbortController;
}

export function createState(config: HetznerConfig = loadConfig()): State {
	return {
		config,
		models: staticCatalog(config),
		ids: [],
		source: "static",
		window: new RateWindow(),
		serverHeaders: {},
		noticeShown: config.quiet,
		refreshing: false,
	};
}
