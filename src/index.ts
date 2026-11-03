/**
 * pi-market — browse and install packages from https://pi.dev/packages
 * without leaving Pi.
 *
 *  /market                  open the interactive browser (TUI)
 *  /market <query>          open the browser with a search
 *  /market refresh          re-download the gallery catalog
 *  /market install <name>   install a package directly
 *
 * Tools `market_search` and `market_install` expose the same catalog to the
 * model so it can find and install packages when the user asks for it.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type CatalogProgress,
	type CatalogSnapshot,
	formatAge,
	formatDownloads,
	galleryUrl,
	loadCatalog,
	type MarketPackage,
	PACKAGE_TYPES,
	searchPackages,
	type SortOrder,
} from "./catalog.ts";
import {
	type InstallScope,
	installPackageSource,
	packageSource,
	readInstalledPackages,
	removePackageSource,
} from "./install.ts";
import { MarketComponent, type MarketResult } from "./ui.ts";

const HELP = [
	"pi-market — pi.dev package gallery browser",
	"",
	"  /market                      browse the gallery (TUI)",
	"  /market <query>              browse with a search",
	"  /market search <query>       print matches",
	"  /market refresh              re-download the gallery catalog",
	"  /market install <name> [-l]  install a package (-l = project-local)",
	"",
	"Keys: ↑↓ move · enter install · ctrl+r remove · ctrl+l scope · ctrl+t type · tab sort · esc close",
	"Clicking a package installs it.",
].join("\n");

type Action = "browse" | "search" | "install" | "refresh" | "help";

interface ParsedCommand {
	action: Action;
	query: string;
	local: boolean;
}

function parseCommand(raw: string): ParsedCommand {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	const local = tokens.some((token) => token === "--local" || token === "-l");
	const cleaned = tokens.filter((token) => token !== "--local" && token !== "-l");
	const first = cleaned[0]?.toLowerCase();

	if (!first) return { action: "browse", query: "", local };
	if (["help", "?", "-h", "--help"].includes(first)) return { action: "help", query: "", local };
	if (["refresh", "update"].includes(first) && cleaned.length === 1) {
		return { action: "refresh", query: "", local };
	}
	if (["search", "find"].includes(first) && cleaned.length > 1) {
		return { action: "search", query: cleaned.slice(1).join(" "), local };
	}
	if (["install", "add"].includes(first) && cleaned.length > 1) {
		return { action: "install", query: cleaned.slice(1).join(" "), local };
	}
	return { action: "browse", query: cleaned.join(" "), local };
}

function typeLabel(pkg: MarketPackage): string {
	return pkg.types.filter((type) => type !== "package").join(",") || "package";
}

function describePackage(pkg: MarketPackage, installed: Map<string, InstallScope[]>): string {
	const scopes = installed.get(pkg.name);
	const status = scopes?.length ? ` · installed (${scopes.join("+")})` : "";
	const downloads = formatDownloads(pkg);
	return [
		`- ${pkg.name} · ${typeLabel(pkg)}${downloads ? ` · ${downloads}` : ""}${status}`,
		`  ${pkg.description || "(no description)"}`,
		`  install: pi install ${pkg.source} · ${galleryUrl(pkg)}`,
	].join("\n");
}

function formatSearchResults(
	packages: MarketPackage[],
	snapshot: CatalogSnapshot,
	installed: Map<string, InstallScope[]>,
	options: { query?: string; shown: number },
): string {
	const header = [
		options.query ? `pi.dev packages matching "${options.query}"` : "pi.dev packages",
		`${options.shown} shown`,
		`catalog: ${snapshot.packages.length.toLocaleString("en-US")} packages, ${formatAge(snapshot.fetchedAt)}${
			snapshot.partial ? " (partial)" : ""
		}`,
	].join(" · ");
	if (packages.length === 0) {
		return `${header}\n\nNo packages matched. Try a shorter query, or /market refresh.`;
	}
	return `${header}\n\n${packages.map((pkg) => describePackage(pkg, installed)).join("\n")}`;
}

export default function marketExtension(pi: ExtensionAPI) {
	async function getCatalog(
		force: boolean,
		signal?: AbortSignal,
		onProgress?: (progress: CatalogProgress) => void,
	): Promise<CatalogSnapshot> {
		return loadCatalog({ force, signal, onProgress });
	}

	function print(ctx: ExtensionCommandContext, text: string): void {
		if (ctx.hasUI) {
			ctx.ui.notify(text, "info");
		} else {
			process.stderr.write(`${text}\n`);
		}
	}

	async function openBrowser(
		ctx: ExtensionCommandContext,
		options: { query?: string; forceRefresh?: boolean },
	): Promise<void> {
		if (ctx.mode !== "tui") {
			const snapshot = await getCatalog(options.forceRefresh === true);
			const installed = await readInstalledPackages();
			const results = searchPackages(snapshot.packages, {
				query: options.query,
				limit: options.query ? 15 : 10,
			});
			print(
				ctx,
				formatSearchResults(results, snapshot, installed, {
					query: options.query,
					shown: results.length,
				}),
			);
			return;
		}

		const result = await ctx.ui.custom<MarketResult | undefined>(
			(tui, theme, keybindings, done) =>
				new MarketComponent(tui, theme, keybindings, done, {
					initialQuery: options.query,
					actions: {
						load: (onProgress, signal) => getCatalog(options.forceRefresh === true, signal, onProgress),
						refreshInstalled: () => readInstalledPackages(),
						install: (pkg, scope, signal) => installPackageSource(pi, pkg.source, scope, signal),
						remove: (pkg, scope, signal) => removePackageSource(pi, pkg.source, scope, signal),
					},
				}),
			{ blocked: { kind: "question", message: "Browsing the pi.dev package gallery" } },
		);

		const installed = result?.installed ?? [];
		if (installed.length === 0) return;

		const ok = await ctx.ui.confirm(
			"Reload Pi?",
			`Pi packages changed:\n${installed.join("\n")}\n\nReload now to apply the changes?`,
		);
		if (ok) {
			await ctx.reload();
		} else {
			ctx.ui.notify("Run /reload when you want to load the new packages.", "info");
		}
	}

	pi.registerCommand("market", {
		description: "Browse and install packages from pi.dev/packages",
		getArgumentCompletions: (prefix) => {
			const options: Array<{ value: string; description: string }> = [
				{ value: "refresh", description: "Re-download the gallery catalog" },
				{ value: "search", description: "Print matching packages" },
				{ value: "install", description: "Install a package by name" },
				{ value: "help", description: "Show help" },
			];
			const items = options
				.filter((option) => option.value.startsWith(prefix.trim()))
				.map((option) => ({ ...option, label: option.value }));
			return items.length > 0 ? items : null;
		},
		handler: async (rawArgs, ctx) => {
			const command = parseCommand(rawArgs);

			if (command.action === "help") {
				print(ctx, HELP);
				return;
			}

			if (command.action === "refresh") {
				if (ctx.hasUI) ctx.ui.setStatus("pi-market", "Refreshing pi.dev catalog…");
				try {
					const snapshot = await getCatalog(true);
					const message =
						`Catalog refreshed: ${snapshot.packages.length.toLocaleString("en-US")} packages` +
						`${snapshot.partial ? " (some pages failed)" : ""}.`;
					if (ctx.hasUI) ctx.ui.notify(message, "info");
					else process.stderr.write(`${message}\n`);
				} catch (error) {
					const message = `Catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`;
					if (ctx.hasUI) ctx.ui.notify(message, "error");
					else process.stderr.write(`${message}\n`);
				} finally {
					if (ctx.hasUI) ctx.ui.setStatus("pi-market", undefined);
				}
				return;
			}

			if (command.action === "install") {
				const source = packageSource(command.query);
				const scope: InstallScope = command.local ? "project" : "user";
				if (ctx.hasUI) ctx.ui.setStatus("pi-market", `Installing ${source}…`);
				const outcome = await installPackageSource(pi, source, scope);
				if (ctx.hasUI) ctx.ui.setStatus("pi-market", undefined);

				if (!outcome.ok) {
					if (ctx.hasUI) {
						ctx.ui.notify(outcome.message, "error");
					} else {
						process.stderr.write(`${outcome.message}\n`);
					}
					return;
				}

				if (ctx.mode === "tui") {
					const reload = await ctx.ui.confirm(
						"Package installed",
						`${outcome.message}.\n\nReload Pi now to load it?`,
					);
					if (reload) {
						await ctx.reload();
						return;
					}
				}
				print(ctx, `${outcome.message}. Run /reload to load it.`);
				return;
			}

			await openBrowser(ctx, { query: command.query });
		},
	});

	pi.registerTool({
		name: "market_search",
		label: "Pi Market Search",
		description:
			"Search the pi.dev package gallery (extensions, skills, themes, prompts) and return package names, descriptions, and install commands.",
		promptSnippet: "Search https://pi.dev/packages for installable pi packages",
		promptGuidelines: [
			"Use market_search when the user asks to find, discover, or install pi packages from the pi.dev gallery.",
			"market_search only reads the catalog; use market_install to install a result.",
		],
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({ description: "Search terms; matches package name, description, author, and keywords." }),
			),
			type: Type.Optional(
				StringEnum(["all", ...PACKAGE_TYPES] as const, { description: "Filter by package type." }),
			),
			sort: Type.Optional(StringEnum(["downloads", "recent", "name"] as const, { description: "Result order." })),
			limit: Type.Optional(
				Type.Number({ description: "Maximum results to return (default 20, max 50).", minimum: 1, maximum: 50 }),
			),
			refresh: Type.Optional(
				Type.Boolean({ description: "Download the gallery again instead of using the local cache." }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const snapshot = await getCatalog(params.refresh === true, signal);
			const installed = await readInstalledPackages();
			const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 20)));
			const results = searchPackages(snapshot.packages, {
				query: params.query,
				type: params.type as string | undefined,
				sort: params.sort as SortOrder | undefined,
				limit,
			});
			const text = formatSearchResults(results, snapshot, installed, {
				query: params.query,
				shown: results.length,
			});
			return {
				content: [{ type: "text" as const, text }],
				details: {
					query: params.query ?? null,
					totalCatalog: snapshot.packages.length,
					cachedAt: snapshot.fetchedAt,
					partial: snapshot.partial,
					results: results.map((pkg) => ({
						name: pkg.name,
						source: pkg.source,
						description: pkg.description,
						types: pkg.types,
						downloads: pkg.downloads,
						author: pkg.author,
						installed: installed.get(pkg.name) ?? [],
					})),
				},
			};
		},
	});

	pi.registerTool({
		name: "market_install",
		label: "Pi Market Install",
		description:
			"Install a package from the pi.dev gallery (or any pi source) with `pi install`, then ask the user to reload Pi.",
		promptSnippet: "Install a pi package from the pi.dev gallery",
		promptGuidelines: [
			"Use market_install only after the user explicitly agrees to install a specific package.",
			"market_install asks for confirmation in interactive sessions and runs `pi install`.",
		],
		parameters: Type.Object({
			name: Type.String({
				description:
					"Package name (pi-subagents, @scope/pkg) or full source (npm:..., git:..., https://..., ./path).",
			}),
			scope: Type.Optional(
				StringEnum(["user", "project"] as const, {
					description: "user = global settings (default), project = .pi/settings.json in the current directory.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const source = packageSource(params.name);
			const scope: InstallScope = params.scope === "project" ? "project" : "user";

			if (ctx?.hasUI) {
				const ok = await ctx.ui.confirm(
					"Install Pi package?",
					`pi install ${source}${scope === "project" ? " --local" : ""}\n\nExtensions run with your full permissions. Only install packages you trust.`,
				);
				if (!ok) {
					return {
						content: [{ type: "text" as const, text: "Install cancelled by the user." }],
						details: { source, scope, ok: false, cancelled: true },
					};
				}
			}

			const outcome = await installPackageSource(pi, source, scope, signal);
			const text = outcome.ok
				? `${outcome.message}.\nRun /reload (or restart Pi) to load the package.`
				: outcome.message;
			return {
				content: [{ type: "text" as const, text }],
				details: { source, scope, ok: outcome.ok, cancelled: false },
			};
		},
	});
}
