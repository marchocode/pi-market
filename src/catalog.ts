/**
 * pi.dev package gallery catalog.
 *
 * The gallery (https://pi.dev/packages) is server-rendered HTML with one
 * `<article data-package-card>` per package and 50 packages per page. This
 * module fetches every page, parses the cards, and keeps a small on-disk cache
 * so `/market` opens instantly after the first run.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const GALLERY_ORIGIN = "https://pi.dev";
export const GALLERY_URL = `${GALLERY_ORIGIN}/packages`;

export const PACKAGE_TYPES = ["extension", "skill", "theme", "prompt"] as const;
export type PackageType = (typeof PACKAGE_TYPES)[number];
export type SortOrder = "downloads" | "recent" | "name";

const CACHE_VERSION = 1;
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PARTIAL_CACHE_TTL_MS = 10 * 60 * 1000;
const PAGE_TIMEOUT_MS = 25_000;
const PAGE_RETRIES = 2;
const DEFAULT_CONCURRENCY = 5;

const USER_AGENT = `pi-market/0.1 (+${GALLERY_URL})`;

export interface MarketPackage {
	/** npm package name, e.g. `pi-subagents` or `@scope/pkg`. */
	name: string;
	description: string;
	author: string;
	downloads: number;
	/** Human readable download count from the gallery, e.g. `50.5K/mo`. */
	downloadsLabel: string;
	/** Human readable publish age from the gallery, e.g. `4d ago`. */
	updatedLabel: string;
	/** Publish timestamp in epoch milliseconds, when the gallery exposes it. */
	publishedAt?: number;
	/** `extension`, `skill`, `theme`, `prompt`, or `package` for plain packages. */
	types: string[];
	/** Gallery page path, e.g. `/packages/pi-subagents`. */
	path: string;
	/** Install source, e.g. `npm:pi-subagents`. */
	source: string;
	/** Lowercased haystack used for local fuzzy search. */
	searchText: string;
}

export interface CatalogSnapshot {
	packages: MarketPackage[];
	total: number;
	totalPages: number;
	fetchedAt: number;
	/** True when some pages failed; the snapshot is newer but incomplete. */
	partial: boolean;
}

export interface CatalogProgress {
	loadedPages: number;
	totalPages: number;
	packages: number;
}

export interface LoadCatalogOptions {
	force?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: CatalogProgress) => void;
	concurrency?: number;
}

export function agentConfigDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	return override || join(homedir(), ".pi", "agent");
}

export function catalogCachePath(): string {
	return join(agentConfigDir(), "cache", "pi-market", "catalog.json");
}

export function npmSource(name: string): string {
	return `npm:${name}`;
}

export function galleryUrl(pkg: MarketPackage): string {
	return `${GALLERY_ORIGIN}${pkg.path}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function decodeEntities(input: string): string {
	return input
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
		.replace(/&nbsp;/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/&apos;|&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/** Remove C0/C1 control characters so untrusted package text cannot drive the terminal. */
function sanitizeText(input: string): string {
	return input.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function textOf(html: string): string {
	return sanitizeText(decodeEntities(html.replace(/<[^>]*>/g, " ")))
		.replace(/\s+/g, " ")
		.trim();
}

function attribute(tag: string, name: string): string | undefined {
	const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
	return match?.[1] === undefined ? undefined : sanitizeText(decodeEntities(match[1]));
}

function numberOf(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Parse one gallery page. Exported for tests and previews.
 */
export function parseCatalogPage(html: string): {
	packages: MarketPackage[];
	total?: number;
	totalPages?: number;
} {
	const packages: MarketPackage[] = [];
	const seen = new Set<string>();
	const articlePattern =
		/<article\b([^>]*\bdata-package-card="true"[^>]*)>([\s\S]*?)<\/article>/gi;

	for (const match of html.matchAll(articlePattern)) {
		const tag = match[1] ?? "";
		const body = match[2] ?? "";
		const name = attribute(tag, "data-package-name");
		if (!name || seen.has(name)) continue;
		seen.add(name);

		const descriptionMatch = body.match(/<p[^>]*class="[^"]*packages-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
		const description = descriptionMatch ? textOf(descriptionMatch[1] ?? "") : "";

		const metaBlock = body.match(/<div[^>]*class="[^"]*packages-meta[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
		const metaValues = metaBlock
			? [...(metaBlock[1] ?? "").matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)].map((m) =>
					textOf(m[1] ?? ""),
				)
			: [];

		const badgeTypes = [
			...body.matchAll(/<span[^>]*class="[^"]*packages-badge[^"]*"[^>]*data-type="([^"]*)"/gi),
		].map((m) => decodeEntities(m[1] ?? "").trim());

		const declaredTypes = (attribute(tag, "data-package-types") ?? "")
			.split(/\s+/)
			.map((type) => type.trim())
			.filter(Boolean);

		const types = [...new Set([...declaredTypes, ...badgeTypes])].filter(Boolean);
		if (types.length === 0) types.push("package");

		const rawSearch = attribute(tag, "data-package-search") ?? "";
		const path = attribute(tag, "data-package-path") ?? `/packages/${name}`;
		const publishedAt = numberOf(attribute(tag, "data-package-date")) || undefined;

		packages.push({
			name,
			description,
			author: metaValues[0] ?? "",
			downloads: numberOf(attribute(tag, "data-package-downloads")),
			downloadsLabel: metaValues[1] ?? "",
			updatedLabel: metaValues[2] ?? "",
			publishedAt,
			types,
			path,
			source: npmSource(name),
			searchText: `${rawSearch} ${name} ${description} ${types.join(" ")}`.toLowerCase(),
		});
	}

	const totalMatch = html.match(/class="[^"]*packages-count[^"]*"[^>]*>([^<]*)</i);
	const total = totalMatch ? numberOf((totalMatch[1] ?? "").replace(/[\s,]/g, "").split("/").pop()) : undefined;

	let totalPages: number | undefined;
	for (const match of html.matchAll(/\?page=(\d+)/g)) {
		const page = numberOf(match[1]);
		if (page > (totalPages ?? 0)) totalPages = page;
	}
	if (!totalPages && total) totalPages = Math.ceil(total / 50);

	return { packages, total, totalPages };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function fetchPage(page: number, signal?: AbortSignal): Promise<string> {
	const url = page <= 1 ? GALLERY_URL : `${GALLERY_URL}?page=${page}`;
	let lastError: unknown;

	for (let attempt = 0; attempt <= PAGE_RETRIES; attempt++) {
		if (signal?.aborted) throw new Error("Aborted");
		try {
			const timeout = AbortSignal.timeout(PAGE_TIMEOUT_MS);
			const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const response = await fetch(url, {
				headers: {
					accept: "text/html,application/xhtml+xml",
					"user-agent": USER_AGENT,
				},
				signal: combined,
			});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}`);
			}
			return await response.text();
		} catch (error) {
			lastError = error;
			if (signal?.aborted) throw new Error("Aborted");
			if (attempt < PAGE_RETRIES) {
				await sleep(250 * (attempt + 1), signal);
			}
		}
	}

	throw new Error(`Failed to fetch ${url}: ${errorMessage(lastError)}`);
}

interface CacheFile {
	version: number;
	snapshot: CatalogSnapshot;
}

export async function readCachedCatalog(): Promise<CatalogSnapshot | undefined> {
	try {
		const raw = await readFile(catalogCachePath(), "utf8");
		const parsed = JSON.parse(raw) as CacheFile;
		if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.snapshot?.packages)) {
			return undefined;
		}
		return parsed.snapshot;
	} catch {
		return undefined;
	}
}

async function writeCachedCatalog(snapshot: CatalogSnapshot): Promise<void> {
	const file = catalogCachePath();
	try {
		await mkdir(dirname(file), { recursive: true });
		const temp = `${file}.${process.pid}.tmp`;
		const payload: CacheFile = { version: CACHE_VERSION, snapshot };
		await writeFile(temp, JSON.stringify(payload), "utf8");
		await rename(temp, file);
	} catch {
		// A read-only or full disk should not break browsing.
	}
}

/**
 * Load the catalog from cache when fresh, otherwise fetch every gallery page.
 */
export async function loadCatalog(options: LoadCatalogOptions = {}): Promise<CatalogSnapshot> {
	if (!options.force) {
		const cached = await readCachedCatalog();
		if (cached) {
			const ttl = cached.partial ? PARTIAL_CACHE_TTL_MS : CACHE_TTL_MS;
			if (Date.now() - cached.fetchedAt < ttl) {
				options.onProgress?.({
					loadedPages: cached.totalPages,
					totalPages: cached.totalPages,
					packages: cached.packages.length,
				});
				return cached;
			}
		}
	}

	const signal = options.signal;
	const firstHtml = await fetchPage(1, signal);
	const first = parseCatalogPage(firstHtml);
	if (first.packages.length === 0) {
		throw new Error("pi.dev returned no packages; the gallery markup may have changed.");
	}

	const byName = new Map<string, MarketPackage>();
	for (const pkg of first.packages) byName.set(pkg.name, pkg);

	const totalPages = Math.max(1, first.totalPages ?? 1);
	const total = first.total ?? byName.size;
	let loadedPages = 1;
	const failedPages: number[] = [];
	options.onProgress?.({ loadedPages, totalPages, packages: byName.size });

	const remaining: number[] = [];
	for (let page = 2; page <= totalPages; page++) remaining.push(page);

	const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, remaining.length || 1));
	let cursor = 0;

	const worker = async () => {
		while (true) {
			if (signal?.aborted) throw new Error("Aborted");
			const index = cursor++;
			const page = remaining[index];
			if (page === undefined) return;
			try {
				const html = await fetchPage(page, signal);
				for (const pkg of parseCatalogPage(html).packages) {
					byName.set(pkg.name, pkg);
				}
			} catch (error) {
				if (signal?.aborted) throw error;
				failedPages.push(page);
			}
			loadedPages++;
			options.onProgress?.({ loadedPages, totalPages, packages: byName.size });
		}
	};

	await Promise.all(
		Array.from({ length: concurrency }, () => worker()),
	);

	const snapshot: CatalogSnapshot = {
		packages: [...byName.values()],
		total,
		totalPages,
		fetchedAt: Date.now(),
		partial: failedPages.length > 0,
	};

	if (snapshot.packages.length > 0) {
		await writeCachedCatalog(snapshot);
	}
	return snapshot;
}

export function sortPackages(packages: MarketPackage[], sort: SortOrder): MarketPackage[] {
	const copy = [...packages];
	if (sort === "name") {
		copy.sort((a, b) => a.name.localeCompare(b.name));
	} else if (sort === "recent") {
		copy.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
	} else {
		copy.sort((a, b) => b.downloads - a.downloads);
	}
	return copy;
}

export interface SearchOptions {
	query?: string;
	type?: string;
	sort?: SortOrder;
	limit?: number;
}

/**
 * Token search used by the `market_search` tool and non-TUI output. The TUI
 * uses pi-tui's fuzzy filter for a nicer interactive experience.
 */
export function searchPackages(packages: MarketPackage[], options: SearchOptions = {}): MarketPackage[] {
	const query = options.query?.trim().toLowerCase() ?? "";
	const type = options.type?.trim().toLowerCase();
	let result = packages;

	if (type && type !== "all") {
		result = result.filter((pkg) => pkg.types.includes(type));
	}

	if (query) {
		const tokens = query.split(/\s+/).filter(Boolean);
		result = result.filter((pkg) => tokens.every((token) => pkg.searchText.includes(token)));
	}

	result = sortPackages(result, options.sort ?? "downloads");
	const limit = options.limit ?? 20;
	return limit > 0 ? result.slice(0, limit) : result;
}

export function formatDownloads(pkg: MarketPackage): string {
	return pkg.downloadsLabel || (pkg.downloads > 0 ? pkg.downloads.toLocaleString("en-US") : "");
}

export function formatAge(timestamp: number | undefined): string {
	if (!timestamp) return "unknown";
	const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	return `${days}d ago`;
}
