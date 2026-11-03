/**
 * Interactive market browser rendered through `ctx.ui.custom()`.
 *
 * The component owns only presentation and navigation. Catalog fetching and
 * `pi install` / `pi remove` run through the callbacks in MarketActions so the
 * extension entry point stays testable and side effects are explicit.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	type Keybinding,
	matchesKey,
	type KeybindingsManager,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	type CatalogProgress,
	type CatalogSnapshot,
	formatAge,
	formatDownloads,
	galleryUrl,
	type MarketPackage,
	PACKAGE_TYPES,
	type SortOrder,
} from "./catalog.ts";
import type { InstallOutcome, InstallScope } from "./install.ts";

const SORTS: SortOrder[] = ["downloads", "recent", "name"];
const TYPE_FILTERS = ["all", ...PACKAGE_TYPES] as const;
type TypeFilter = (typeof TYPE_FILTERS)[number];

export interface MarketResult {
	/** Package sources installed during this browsing session. */
	installed: string[];
}

export interface MarketActions {
	load(onProgress: (progress: CatalogProgress) => void, signal: AbortSignal): Promise<CatalogSnapshot>;
	refreshInstalled(): Promise<Map<string, InstallScope[]>>;
	install(pkg: MarketPackage, scope: InstallScope, signal: AbortSignal): Promise<InstallOutcome>;
	remove(pkg: MarketPackage, scope: InstallScope, signal: AbortSignal): Promise<InstallOutcome>;
}

export interface MarketOptions {
	actions: MarketActions;
	initialQuery?: string;
}

type NoticeKind = "info" | "success" | "error";

interface Notice {
	kind: NoticeKind;
	text: string;
}

interface BusyState {
	label: string;
	controller: AbortController;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/** 0 = exact, 1 = name prefix, 2 = every token in the name, 3 = only description/keywords. */
function nameRank(name: string, tokens: string[]): number {
	const lower = name.toLowerCase();
	const joined = tokens.join(" ");
	if (lower === joined) return 0;
	if (tokens.every((token) => lower.includes(token))) {
		return tokens[0] && lower.startsWith(tokens[0]) ? 1 : 2;
	}
	return tokens.some((token) => lower.includes(token)) ? 2 : 3;
}

function countLabel(value: number): string {
	return value.toLocaleString("en-US");
}

export class MarketComponent {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (result: MarketResult) => void;
	private readonly actions: MarketActions;

	private catalog?: CatalogSnapshot;
	private loading = true;
	private loadError?: string;
	private progress?: CatalogProgress;
	private loadController = new AbortController();

	private query: string;
	private queryCursor: number;
	private typeFilter: TypeFilter = "all";
	private sort: SortOrder = "downloads";
	private scope: InstallScope = "user";

	private filtered: MarketPackage[] = [];
	private selected = 0;
	private scrollTop = 0;
	private installed = new Map<string, InstallScope[]>();
	private changedSources: string[] = [];

	private busy?: BusyState;
	private notice?: Notice;
	private armedRemoval?: string;
	private finished = false;

	private cachedLines?: string[];
	private cachedWidth?: number;
	private rowMap = new Map<number, number>();
	private listHeight = 12;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: MarketResult) => void,
		options: MarketOptions,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.actions = options.actions;
		this.query = options.initialQuery ?? "";
		this.queryCursor = this.query.length;
		void this.bootstrap();
	}

	private async bootstrap(): Promise<void> {
		try {
			const snapshot = await this.actions.load((progress) => {
				this.progress = progress;
				this.refresh();
			}, this.loadController.signal);
			if (this.finished) return;
			this.catalog = snapshot;
			this.loading = false;
			this.loadError = undefined;
			this.rebuild({ resetSelection: true });
			try {
				this.installed = await this.actions.refreshInstalled();
			} catch {
				// Installed markers are best effort.
			}
		} catch (error) {
			if (this.loadController.signal.aborted || this.finished) return;
			this.loading = false;
			this.loadError = messageOf(error);
		}
		this.refresh();
	}

	private retry(): void {
		if (this.loading) return;
		this.loadController.abort();
		this.loadController = new AbortController();
		this.loading = true;
		this.loadError = undefined;
		this.progress = undefined;
		this.refresh();
		void this.bootstrap();
	}

	private rebuild(options: { resetSelection?: boolean } = {}): void {
		const all = this.catalog?.packages ?? [];
		const previousName = options.resetSelection ? undefined : this.filtered[this.selected]?.name;

		let items = all;
		if (this.typeFilter !== "all") {
			items = items.filter((pkg) => pkg.types.includes(this.typeFilter));
		}

		const query = this.query.trim();
		if (query) {
			const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
			const strict = items.filter((pkg) => tokens.every((token) => pkg.searchText.includes(token)));
			if (strict.length > 0) {
				const rank = new Map<string, number>();
				for (const pkg of strict) rank.set(pkg.name, nameRank(pkg.name, tokens));
				items = [...strict].sort((a, b) => {
					const rankDiff = (rank.get(a.name) ?? 9) - (rank.get(b.name) ?? 9);
					if (rankDiff !== 0) return rankDiff;
					if (this.sort === "name") return a.name.localeCompare(b.name);
					if (this.sort === "recent") return (b.publishedAt ?? 0) - (a.publishedAt ?? 0);
					return b.downloads - a.downloads;
				});
			} else {
				items = fuzzyFilter(items, query, (pkg) => pkg.searchText);
			}
		} else {
			const sorted = [...items];
			if (this.sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
			else if (this.sort === "recent") sorted.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
			else sorted.sort((a, b) => b.downloads - a.downloads);
			items = sorted;
		}

		this.filtered = items;
		if (previousName) {
			const index = items.findIndex((pkg) => pkg.name === previousName);
			this.selected = index >= 0 ? index : clamp(this.selected, 0, Math.max(0, items.length - 1));
		} else {
			this.selected = 0;
		}
		if (this.selected >= items.length) this.selected = Math.max(0, items.length - 1);
	}

	private selectedPackage(): MarketPackage | undefined {
		return this.filtered[this.selected];
	}

	private installSelected(): void {
		const pkg = this.selectedPackage();
		if (!pkg || this.busy || this.loading) return;
		const controller = new AbortController();
		this.busy = { label: `Installing ${pkg.source} (${this.scope})`, controller };
		this.notice = undefined;
		this.armedRemoval = undefined;
		this.refresh();

		void (async () => {
			const outcome = await this.actions.install(pkg, this.scope, controller.signal);
			if (this.finished) return;
			this.busy = undefined;
			this.notice = {
				kind: outcome.ok ? "success" : controller.signal.aborted ? "info" : "error",
				text: outcome.message,
			};
			if (outcome.ok) {
				if (!this.changedSources.includes(outcome.source)) {
					this.changedSources.push(outcome.source);
				}
				try {
					this.installed = await this.actions.refreshInstalled();
				} catch {
					// Keep the previous markers.
				}
				this.notice.text = `${outcome.message}. Close the market to reload Pi.`;
			}
			this.refresh();
		})();
	}

	private removeSelected(): void {
		const pkg = this.selectedPackage();
		if (!pkg || this.busy) return;
		const scopes = this.installed.get(pkg.name) ?? [];
		if (scopes.length === 0) {
			this.notice = { kind: "info", text: `${pkg.source} is not installed.` };
			this.armedRemoval = undefined;
			this.refresh();
			return;
		}

		const scope: InstallScope = scopes.includes(this.scope) ? this.scope : scopes[0]!;
		if (this.armedRemoval !== pkg.name) {
			this.armedRemoval = pkg.name;
			this.notice = {
				kind: "info",
				text: `Press ctrl+r again to remove ${pkg.source} (${scope}).`,
			};
			this.refresh();
			return;
		}

		this.armedRemoval = undefined;
		const controller = new AbortController();
		this.busy = { label: `Removing ${pkg.source} (${scope})`, controller };
		this.notice = undefined;
		this.refresh();

		void (async () => {
			const outcome = await this.actions.remove(pkg, scope, controller.signal);
			if (this.finished) return;
			this.busy = undefined;
			if (outcome.ok) {
				// Net-zero when the same package was installed and removed in this session.
				const index = this.changedSources.indexOf(outcome.source);
				if (index >= 0) this.changedSources.splice(index, 1);
				else this.changedSources.push(outcome.source);
			}
			this.notice = {
				kind: outcome.ok ? "success" : controller.signal.aborted ? "info" : "error",
				text: outcome.ok ? `${outcome.message}. Close the market to reload Pi.` : outcome.message,
			};
			try {
				this.installed = await this.actions.refreshInstalled();
			} catch {
				// Keep the previous markers.
			}
			this.refresh();
		})();
	}

	private close(): void {
		if (this.finished) return;
		this.finished = true;
		this.loadController.abort();
		this.busy?.controller.abort();
		this.done({ installed: [...this.changedSources] });
	}

	private refresh(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
		this.tui.requestRender();
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	dispose(): void {
		this.finished = true;
		this.loadController.abort();
		this.busy?.controller.abort();
	}

	private action(data: string, ...bindings: Keybinding[]): boolean {
		return bindings.some((binding) => this.keybindings.matches(data, binding));
	}

	handleInput(data: string): void {
		if (this.loading || this.loadError) {
			if (this.action(data, "tui.select.cancel")) {
				this.close();
			} else if (this.loadError && this.action(data, "tui.select.confirm")) {
				this.retry();
			}
			return;
		}

		if (this.action(data, "tui.select.cancel")) {
			if (this.busy) {
				this.busy.controller.abort();
				return;
			}
			if (this.armedRemoval) {
				this.armedRemoval = undefined;
				this.notice = undefined;
				this.refresh();
				return;
			}
			if (this.query.length > 0) {
				this.setQuery("");
				return;
			}
			this.close();
			return;
		}

		// Remove: ctrl+r, armed with a second press.
		if (matchesKey(data, "ctrl+r")) {
			this.removeSelected();
			return;
		}

		// Toggle install scope between user and project-local.
		if (matchesKey(data, "ctrl+l")) {
			this.scope = this.scope === "user" ? "project" : "user";
			this.notice = {
				kind: "info",
				text: `Install scope: ${this.scope}${this.scope === "project" ? " (.pi/settings.json)" : " (~/.pi/agent/settings.json)"}`,
			};
			this.refresh();
			return;
		}

		// Cycle package type filter.
		if (matchesKey(data, "ctrl+t")) {
			const index = TYPE_FILTERS.indexOf(this.typeFilter);
			this.typeFilter = TYPE_FILTERS[(index + 1) % TYPE_FILTERS.length]!;
			this.rebuild();
			this.refresh();
			return;
		}

		// Cycle sort order.
		if (matchesKey(data, "tab")) {
			const index = SORTS.indexOf(this.sort);
			this.sort = SORTS[(index + 1) % SORTS.length]!;
			this.rebuild();
			this.refresh();
			return;
		}

		if (this.action(data, "tui.select.confirm")) {
			this.installSelected();
			return;
		}

		if (this.action(data, "tui.select.up") || matchesKey(data, "ctrl+p")) {
			this.moveSelection(-1);
			return;
		}
		if (this.action(data, "tui.select.down") || matchesKey(data, "ctrl+n")) {
			this.moveSelection(1);
			return;
		}
		if (this.action(data, "tui.select.pageUp")) {
			this.moveSelection(-Math.max(1, this.listHeight - 1));
			return;
		}
		if (this.action(data, "tui.select.pageDown")) {
			this.moveSelection(Math.max(1, this.listHeight - 1));
			return;
		}

		if (this.action(data, "tui.editor.cursorLeft")) {
			this.queryCursor = Math.max(0, this.queryCursor - 1);
			this.refresh();
			return;
		}
		if (this.action(data, "tui.editor.cursorRight")) {
			this.queryCursor = Math.min(this.query.length, this.queryCursor + 1);
			this.refresh();
			return;
		}
		if (this.action(data, "tui.editor.cursorLineStart") || matchesKey(data, "ctrl+a")) {
			this.queryCursor = 0;
			this.refresh();
			return;
		}
		if (this.action(data, "tui.editor.cursorLineEnd") || matchesKey(data, "ctrl+e")) {
			this.queryCursor = this.query.length;
			this.refresh();
			return;
		}
		if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
			if (this.queryCursor > 0) {
				this.setQuery(this.query.slice(0, this.queryCursor - 1) + this.query.slice(this.queryCursor), this.queryCursor - 1);
			}
			return;
		}
		if (matchesKey(data, "delete")) {
			if (this.queryCursor < this.query.length) {
				this.setQuery(
					this.query.slice(0, this.queryCursor) + this.query.slice(this.queryCursor + 1),
					this.queryCursor,
				);
			}
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			this.setQuery(this.query.slice(this.queryCursor), 0);
			return;
		}
		if (matchesKey(data, "ctrl+w") || matchesKey(data, "alt+backspace")) {
			const before = this.query.slice(0, this.queryCursor);
			const trimmed = before.replace(/\S+\s*$/, "");
			this.setQuery(trimmed + this.query.slice(this.queryCursor), trimmed.length);
			return;
		}

		if (!data.startsWith("\u001b") && !/[\u0000-\u001f\u007f]/.test(data)) {
			const insert = data.replace(/[\u0000-\u001f\u007f]/g, " ");
			const next = this.query.slice(0, this.queryCursor) + insert + this.query.slice(this.queryCursor);
			this.setQuery(next, this.queryCursor + insert.length);
		}
	}

	private moveSelection(delta: number): void {
		if (this.filtered.length === 0) return;
		this.selected = clamp(this.selected + delta, 0, this.filtered.length - 1);
		this.armedRemoval = undefined;
		this.refresh();
	}

	private setQuery(value: string, cursor = value.length): void {
		this.query = value;
		this.queryCursor = clamp(cursor, 0, value.length);
		this.rebuild({ resetSelection: true });
		this.armedRemoval = undefined;
		this.refresh();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			const delta = event.wheelDelta ?? 0;
			if (delta !== 0) {
				this.moveSelection(delta > 0 ? 3 : -3);
				return { handled: true };
			}
			return undefined;
		}

		if (event.type !== "press" && event.type !== "click") return undefined;
		if (event.button !== "left") return undefined;

		const index = this.rowMap.get(event.y);
		if (index === undefined) return undefined;
		this.selected = index;
		this.armedRemoval = undefined;
		this.installSelected();
		return { handled: true };
	}

	private pad(text: string, width: number): string {
		const textWidth = visibleWidth(text);
		if (textWidth >= width) return truncateToWidth(text, width, "");
		return text + " ".repeat(width - textWidth);
	}

	private installedLabel(pkg: MarketPackage): string {
		const scopes = this.installed.get(pkg.name);
		if (!scopes || scopes.length === 0) return "";
		const label = scopes.join("+");
		return `${this.theme.fg("success", "✓")}${this.theme.fg("dim", label)}`;
	}

	private typeLabel(pkg: MarketPackage): string {
		return pkg.types.filter((type) => type !== "package").join(",") || "package";
	}

	private renderQueryLine(): string {
		const theme = this.theme;
		const before = this.query.slice(0, this.queryCursor);
		const at = this.query.slice(this.queryCursor, this.queryCursor + 1);
		const after = this.query.slice(this.queryCursor + 1);
		const cursor = theme.inverse(at || " ");
		const placeholder =
			this.query.length === 0 ? theme.fg("dim", " type to filter · package name, description, author") : "";
		return `${theme.fg("accent", "/")} ${before}${cursor}${after}${placeholder}`;
	}

	private renderFilterLine(): string {
		const theme = this.theme;
		const count = this.catalog?.packages.length ?? 0;
		const shown = this.filtered.length;
		const parts = [
			`${theme.fg("dim", "type ")}${theme.fg("accent", this.typeFilter)}`,
			`${theme.fg("dim", "sort ")}${theme.fg("accent", this.sort)}`,
			`${theme.fg("dim", "scope ")}${theme.fg(this.scope === "project" ? "warning" : "accent", this.scope)}`,
			`${theme.fg("dim", "show ")}${theme.fg("muted", `${shown.toLocaleString("en-US")}/${count.toLocaleString("en-US")}`)}`,
		];
		return parts.join(theme.fg("borderMuted", " · "));
	}

	private renderListRow(pkg: MarketPackage, index: number, leftWidth: number): string {
		const theme = this.theme;
		const isSelected = index === this.selected;
		const marker = isSelected ? theme.fg("accent", "▸ ") : "  ";
		const downloads = formatDownloads(pkg);
		const status = this.installedLabel(pkg);
		const statusWidth = status ? visibleWidth(status) + 2 : 0;
		const downloadsWidth = downloads ? visibleWidth(downloads) : 0;
		const nameWidth = Math.max(10, leftWidth - 2 - downloadsWidth - statusWidth);

		const name = truncateToWidth(pkg.name, nameWidth, "…");
		const nameText = isSelected ? theme.fg("accent", theme.bold(this.pad(name, nameWidth))) : this.pad(name, nameWidth);
		const downloadText = downloads ? this.theme.fg("muted", downloads.padStart(downloadsWidth)) : "";
		const statusText = status ? ` ${status}` : "";
		const line = `${marker}${nameText}${downloadText}${statusText}`;
		const padded = this.pad(line, leftWidth);
		return isSelected ? theme.bg("selectedBg", padded) : padded;
	}

	private detailLines(pkg: MarketPackage | undefined, width: number, height: number): string[] {
		const theme = this.theme;
		if (!pkg) {
			return [theme.fg("dim", "No packages match the current filter.")];
		}
		if (width < 12) return [];

		const scopes = this.installed.get(pkg.name) ?? [];
		const lines: string[] = [];
		const push = (text: string) => {
			for (const line of wrapTextWithAnsi(text, width)) lines.push(line);
		};

		push(theme.fg("accent", theme.bold(pkg.name)));
		const meta = [pkg.author || "unknown", formatDownloads(pkg), pkg.updatedLabel]
			.filter((part): part is string => Boolean(part))
			.join(" · ");
		push(theme.fg("muted", meta));
		push(
			`${theme.fg("dim", this.typeLabel(pkg))}${theme.fg("borderMuted", " · ")}${
				scopes.length > 0
					? `${theme.fg("success", "installed")}${theme.fg("dim", ` (${scopes.join("+")})`)}`
					: theme.fg("muted", "not installed")
			}`,
		);
		lines.push("");
		push(theme.fg("text", pkg.description || "(no description)"));
		lines.push("");
		push(`${theme.fg("dim", "$ ")}${theme.fg("accent", `pi install ${pkg.source}`)}`);
		push(theme.fg("dim", galleryUrl(pkg)));

		if (lines.length > height) {
			const clipped = lines.slice(0, Math.max(1, height));
			const last = clipped[clipped.length - 1] ?? "";
			clipped[clipped.length - 1] = truncateToWidth(`${last}…`, width, "…");
			return clipped;
		}
		return lines;
	}

	private noticeLines(width: number, maxLines: number): string[] {
		const theme = this.theme;
		if (this.busy) {
			const text = `${theme.fg("warning", "◌")} ${theme.fg("muted", this.busy.label)}${theme.fg("dim", " · esc cancels")}`;
			return wrapTextWithAnsi(text, width).slice(0, maxLines);
		}
		if (!this.notice) return [];
		const color = this.notice.kind === "error" ? "error" : this.notice.kind === "success" ? "success" : "accent";
		const wrapped = wrapTextWithAnsi(theme.fg(color, this.notice.text), width);
		if (wrapped.length <= maxLines) return wrapped;
		// Errors can be long: keep the first line and the trailing guidance.
		return maxLines >= 2 ? [wrapped[0]!, wrapped[wrapped.length - 1]!] : wrapped.slice(0, maxLines);
	}

	private keysLine(): string {
		const theme = this.theme;
		const keys = [
			"↑↓ move",
			"⏎ install",
			"ctrl+r remove",
			"ctrl+l scope",
			"ctrl+t type",
			"tab sort",
			"esc close",
		];
		if (this.changedSources.length > 0) keys.push("reload on close");
		return keys.map((key) => theme.fg("dim", key)).join(theme.fg("borderMuted", " · "));
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const theme = this.theme;
		const rows = this.tui.terminal?.rows ?? 30;
		const wide = width >= 96;
		const lines: string[] = [];
		this.rowMap.clear();

		// Title
		const title = `${theme.bold(theme.fg("accent", "Pi Market"))} ${theme.fg("muted", "pi.dev/packages")}`;
		const count = this.catalog?.packages.length ?? 0;
		let titleRight = "";
		if (this.loading) {
			titleRight = this.progress
				? `${this.progress.loadedPages}/${this.progress.totalPages} pages · ${this.progress.packages.toLocaleString("en-US")} packages`
				: "loading catalog…";
		} else if (this.catalog) {
			titleRight = `${count.toLocaleString("en-US")} packages · ${formatAge(this.catalog.fetchedAt)}${
				this.catalog.partial ? " · partial" : ""
			}`;
		}
		const titleGap = Math.max(1, width - visibleWidth(title) - visibleWidth(titleRight));
		lines.push(this.pad(title + " ".repeat(titleGap) + theme.fg("dim", titleRight), width));
		lines.push(this.pad(this.renderQueryLine(), width));
		lines.push(this.pad(this.renderFilterLine(), width));
		lines.push(theme.fg("borderMuted", "─".repeat(width)));

		// Keep the whole component inside the terminal: fixed chrome plus the
		// narrow layout's selected-package block and up to two notice lines.
		const reserved = wide ? 10 : 15;
		const listHeight = clamp(rows - reserved, 5, 15);
		this.listHeight = listHeight;

		const headerLines = lines.length;
		if (this.loading) {
			lines.push(...this.loadingLines(width, listHeight));
			lines.push(theme.fg("borderMuted", "─".repeat(width)));
		} else if (this.loadError) {
			lines.push(...this.errorLines(width, listHeight));
			lines.push(theme.fg("borderMuted", "─".repeat(width)));
		} else {
			this.scrollTop = clamp(
				this.selected - Math.floor(listHeight / 2),
				0,
				Math.max(0, this.filtered.length - listHeight),
			);

			if (wide) {
				const leftWidth = clamp(Math.floor(width * 0.56), 44, width - 26);
				const separator = theme.fg("borderMuted", "│");
				const rightWidth = Math.max(1, width - leftWidth - 1);
				const right = this.detailLines(this.selectedPackage(), rightWidth, listHeight);

				for (let row = 0; row < listHeight; row++) {
					const index = this.scrollTop + row;
					const pkg = this.filtered[index];
					const left = pkg ? this.renderListRow(pkg, index, leftWidth) : this.pad("", leftWidth);
					const rightText = right[row] ?? "";
					lines.push(this.pad(left, leftWidth) + separator + this.pad(rightText, rightWidth));
					if (pkg) this.rowMap.set(headerLines + row, index);
				}

				// Scroll info lives under the list so the detail pane stays clean.
				const from = this.filtered.length === 0 ? 0 : this.scrollTop + 1;
				const to = Math.min(this.filtered.length, this.scrollTop + listHeight);
				const scrollInfo =
					this.filtered.length > listHeight
						? theme.fg("dim", `  ${countLabel(from)}-${countLabel(to)} of ${countLabel(this.filtered.length)}`)
						: theme.fg("dim", `  ${countLabel(this.filtered.length)} result${this.filtered.length === 1 ? "" : "s"}`);
				lines.push(this.pad(scrollInfo, width));
			} else {
				for (let row = 0; row < listHeight; row++) {
					const index = this.scrollTop + row;
					const pkg = this.filtered[index];
					lines.push(pkg ? this.renderListRow(pkg, index, width) : "");
					if (pkg) this.rowMap.set(headerLines + row, index);
				}
				const selectedPkg = this.selectedPackage();
				const summary = selectedPkg
					? `${theme.fg("accent", selectedPkg.name)} ${theme.fg("dim", "·")} ${theme.fg(
							"muted",
							`${this.typeLabel(selectedPkg)} · ${formatDownloads(selectedPkg) || "-"}${
								this.installedLabel(selectedPkg) ? " · installed" : ""
							}`,
						)}`
					: theme.fg("dim", "No packages match the current filter.");
				lines.push(theme.fg("borderMuted", "─".repeat(width)));
				lines.push(this.pad(truncateToWidth(summary, width, "…"), width));
				const description = selectedPkg?.description ?? "";
				for (const line of wrapTextWithAnsi(theme.fg("muted", description), width).slice(0, 2)) {
					lines.push(this.pad(line, width));
				}
				lines.push(this.pad(theme.fg("dim", selectedPkg ? `$ pi install ${selectedPkg.source}` : ""), width));
			}

			lines.push(theme.fg("borderMuted", "─".repeat(width)));
		}

		for (const line of this.noticeLines(width, 2)) lines.push(this.pad(line, width));
		lines.push(this.pad(this.keysLine(), width));

		this.cachedWidth = width;
		this.cachedLines = lines.map((line) => truncateToWidth(line, width, ""));
		return this.cachedLines;
	}

	private loadingLines(width: number, height: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		lines.push(theme.fg("accent", "  Fetching the package gallery from pi.dev…"));
		if (this.progress) {
			const { loadedPages, totalPages, packages } = this.progress;
			const ratio = totalPages > 0 ? loadedPages / totalPages : 0;
			const barWidth = clamp(width - 30, 10, 50);
			const filled = Math.round(ratio * barWidth);
			const bar = `${theme.fg("success", "█".repeat(filled))}${theme.fg("borderMuted", "░".repeat(barWidth - filled))}`;
			lines.push(`  ${bar} ${theme.fg("muted", `${loadedPages}/${totalPages} pages`)}`);
			lines.push(theme.fg("dim", `  ${packages.toLocaleString("en-US")} packages parsed so far`));
		}
		lines.push(theme.fg("dim", "  First run downloads every gallery page; later runs use a local cache."));
		while (lines.length < height) lines.push("");
		return lines;
	}

	private errorLines(width: number, height: number): string[] {
		const theme = this.theme;
		const lines: string[] = [theme.fg("error", "  Could not load the pi.dev package gallery.")];
		for (const line of wrapTextWithAnsi(theme.fg("muted", this.loadError ?? ""), Math.max(10, width - 4)).slice(0, 3)) {
			lines.push(`  ${line}`);
		}
		lines.push(theme.fg("dim", "  enter retry · esc close"));
		while (lines.length < height) lines.push("");
		return lines;
	}
}
