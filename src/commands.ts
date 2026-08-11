/** The `/hetzner` command: status, catalog, forced refresh, settings. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatTokens } from "./budget.ts";
import { BASE_URL, findSpec, PROVIDER_ID, PROVIDER_NAME, RATE_LIMITS } from "./catalog.ts";
import { saveSetting } from "./config.ts";
import { discoverCatalog, fetchModelIds } from "./discovery.ts";
import { applyCatalog } from "./provider.ts";
import type { State } from "./state.ts";

const SUBCOMMANDS: { name: string; description: string }[] = [
	{ name: "status", description: "Auth, catalog, rate-limit window and reachability" },
	{ name: "models", description: "List the registered Hetzner models" },
	{ name: "refresh", description: "Re-read /v1/models now, ignoring the cache" },
	{ name: "quiet", description: "on|off — silence the experiment notice" },
	{ name: "ask", description: "on|off — register the hetzner_ask delegation tool" },
];

function formatAgo(timestamp: number | undefined, now: number): string {
	if (!timestamp) return "never";
	const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	return `${Math.round(seconds / 3600)}h ago`;
}

function describeAuth(ctx: ExtensionCommandContext): string {
	const status = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID);
	if (!status.configured) return "not configured — run /login hetzner";
	return status.label ? `${status.source ?? "configured"} (${status.label})` : (status.source ?? "configured");
}

async function statusReport(state: State, ctx: ExtensionCommandContext): Promise<string> {
	const now = Date.now();
	const usage = state.window.usage(now);
	const lines = [
		PROVIDER_NAME,
		`  base URL     ${BASE_URL}`,
		`  auth         ${describeAuth(ctx)}`,
		`  models       ${state.models.length} (source: ${state.source}${
			state.source === "static" ? "" : `, checked ${formatAgo(state.checkedAt, now)}`
		})`,
		`  rate window  in ${formatTokens(usage.input)}/${formatTokens(RATE_LIMITS.inputTokens)}` +
			` · out ${formatTokens(usage.output)}/${formatTokens(RATE_LIMITS.outputTokens)}` +
			` · ${usage.samples} response(s)${usage.resetInMs > 0 ? `, oldest expires in ${Math.ceil(usage.resetInMs / 1000)}s` : ""}`,
	];

	if (state.discoveryError) lines.push(`  discovery    ${state.discoveryError}`);
	if (state.last429At) {
		const wait = state.lastRetryAfterSeconds;
		lines.push(`  last 429     ${formatAgo(state.last429At, now)}${wait ? `, Retry-After ${wait}s` : ""}`);
	}
	const headers = Object.entries(state.serverHeaders);
	if (headers.length > 0) {
		lines.push(`  api headers  ${headers.map(([name, value]) => `${name}: ${value}`).join(", ")}`);
	}

	const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
	if (token) {
		const started = Date.now();
		try {
			const ids = await fetchModelIds(token);
			lines.push(`  reachability ok, ${ids.length} models in ${Date.now() - started}ms`);
		} catch (error) {
			lines.push(`  reachability failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	lines.push("  note         experimental service: no SLA, may be withdrawn at any time");
	return lines.join("\n");
}

function modelsReport(state: State): string {
	const lines = [`${state.models.length} model(s) registered from ${state.source}:`];
	for (const model of state.models) {
		const spec = findSpec(model.id);
		// contextWindow is the input budget: max_model_len minus the reserved output room.
		const details = [
			`${formatTokens(model.contextWindow)} in + ${formatTokens(model.maxTokens)} out`,
			model.input.includes("image") ? "text+image" : "text",
		];
		if (spec) details.push(spec.note);
		else details.push("unknown to this package, conservative defaults");
		lines.push(`  ${PROVIDER_ID}/${model.id}`, `      ${details.join(" · ")}`);
	}
	lines.push("Select one with: /model hetzner/<id>");
	return lines.join("\n");
}

async function refresh(state: State, pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string> {
	const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
	if (!token) return "No API token configured — run /login hetzner first.";

	const result = await discoverCatalog({
		token,
		allowNetwork: true,
		force: true,
		ttlHours: state.config.discoveryTtlHours,
		maxTokens: state.config.maxTokens,
	});
	const change = applyCatalog(pi, state, result);
	if (result.error) return `Refresh failed (${result.error}); keeping ${state.models.length} model(s) from ${state.source}.`;

	const parts = [`Catalog refreshed: ${state.models.length} model(s).`];
	if (change?.added.length) parts.push(`New: ${change.added.join(", ")}.`);
	if (change?.removed.length) parts.push(`Gone: ${change.removed.join(", ")}.`);
	if (result.unknownIds.length > 0) parts.push(`Not in this package's table: ${result.unknownIds.join(", ")}.`);
	if (!change) parts.push("No changes.");
	return parts.join(" ");
}

function toggle(argument: string, current: boolean): boolean | undefined {
	const value = argument.trim().toLowerCase();
	if (["on", "true", "1", "yes"].includes(value)) return true;
	if (["off", "false", "0", "no"].includes(value)) return false;
	if (value === "") return !current;
	return undefined;
}

export function registerCommands(pi: ExtensionAPI, state: State): void {
	pi.registerCommand("hetzner", {
		description: "Hetzner Inference: status, models, refresh, settings",
		getArgumentCompletions: (prefix) =>
			SUBCOMMANDS.filter((entry) => entry.name.startsWith(prefix.trim())).map((entry) => ({
				value: entry.name,
				label: entry.name,
				detail: entry.description,
			})),
		handler: async (args, ctx) => {
			const [subcommand = "status", ...rest] = args.trim().split(/\s+/);
			const argument = rest.join(" ");

			switch (subcommand) {
				case "":
				case "status":
					ctx.ui.notify(await statusReport(state, ctx), "info");
					return;

				case "models":
					ctx.ui.notify(modelsReport(state), "info");
					return;

				case "refresh":
					ctx.ui.notify(await refresh(state, pi, ctx), "info");
					return;

				case "quiet": {
					const value = toggle(argument, state.config.quiet);
					if (value === undefined) {
						ctx.ui.notify("Usage: /hetzner quiet [on|off]", "warning");
						return;
					}
					state.config.quiet = value;
					state.noticeShown = value;
					const saved = saveSetting("quiet", value);
					ctx.ui.notify(
						`Experiment notice ${value ? "silenced" : "enabled"}${saved ? "" : " for this session only (config file not writable)"}.`,
						"info",
					);
					return;
				}

				case "ask": {
					const value = toggle(argument, state.config.ask);
					if (value === undefined) {
						ctx.ui.notify("Usage: /hetzner ask [on|off]", "warning");
						return;
					}
					const saved = saveSetting("ask", value);
					ctx.ui.notify(
						saved
							? `hetzner_ask ${value ? "enabled" : "disabled"}. Run /reload to apply.`
							: "Could not write the config file.",
						saved ? "info" : "error",
					);
					return;
				}

				default:
					ctx.ui.notify(
						[`Unknown subcommand "${subcommand}".`, ...SUBCOMMANDS.map((e) => `  ${e.name} — ${e.description}`)].join("\n"),
						"warning",
					);
			}
		},
	});
}
