/**
 * Install/remove plumbing for pi packages.
 *
 * We shell out to the Pi CLI instead of editing settings.json ourselves so the
 * registry, version pinning, and npm/git handling stay exactly the same as a
 * manual `pi install`. The package only becomes active after a reload, which
 * the caller can trigger with `ctx.reload()`.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentConfigDir } from "./catalog.ts";

export type InstallScope = "user" | "project";

export interface InstallOutcome {
	ok: boolean;
	message: string;
	source: string;
	scope: InstallScope;
}

interface SettingsFile {
	packages?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** `npm:@scope/pkg@1.2.3` -> `@scope/pkg`; non-npm sources return undefined. */
export function npmPackageName(source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const spec = source.slice(4).trim();
	if (!spec) return undefined;
	if (spec.startsWith("@")) {
		const slash = spec.indexOf("/");
		if (slash < 0) return spec;
		const versionAt = spec.indexOf("@", slash + 1);
		return versionAt < 0 ? spec : spec.slice(0, versionAt);
	}
	const versionAt = spec.indexOf("@");
	return versionAt <= 0 ? spec : spec.slice(0, versionAt);
}

function sourceStrings(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const sources: string[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			sources.push(entry);
		} else if (isRecord(entry) && typeof entry.source === "string") {
			sources.push(entry.source);
		}
	}
	return sources;
}

async function readSettingsPackages(file: string): Promise<string[]> {
	try {
		const raw = await readFile(file, "utf8");
		const parsed = JSON.parse(raw) as SettingsFile;
		return sourceStrings(parsed.packages);
	} catch {
		return [];
	}
}

/**
 * Map of gallery package name -> scopes where it is configured.
 */
export async function readInstalledPackages(cwd = process.cwd()): Promise<Map<string, InstallScope[]>> {
	const [userSources, projectSources] = await Promise.all([
		readSettingsPackages(join(agentConfigDir(), "settings.json")),
		readSettingsPackages(join(cwd, ".pi", "settings.json")),
	]);

	const installed = new Map<string, Set<InstallScope>>();
	const add = (sources: string[], scope: InstallScope) => {
		for (const source of sources) {
			const name = npmPackageName(source);
			if (!name) continue;
			const scopes = installed.get(name) ?? new Set<InstallScope>();
			scopes.add(scope);
			installed.set(name, scopes);
		}
	};
	add(userSources, "user");
	add(projectSources, "project");

	const result = new Map<string, InstallScope[]>();
	for (const [name, scopes] of installed) {
		result.set(
			name,
			[...scopes].sort((a, b) => (a === b ? 0 : a === "project" ? -1 : 1)),
		);
	}
	return result;
}

export function packageSource(nameOrSource: string): string {
	const value = nameOrSource.trim();
	if (!value) return value;
	if (/^(npm:|git:|https?:|ssh:|file:|\.{0,2}\/)/i.test(value)) return value;
	return `npm:${value}`;
}

function looksLikePiScript(path: string): boolean {
	const file = basename(path);
	return (
		file === "pi" ||
		file === "pi.js" ||
		file === "pi.mjs" ||
		file === "cli.js" ||
		path.includes("pi-coding-agent")
	);
}

interface PiCommand {
	command: string;
	prefix: string[];
}

/**
 * Find a way to invoke the Pi CLI from inside Pi.
 *
 * `process.argv[1]` is the Pi entry script when Pi runs under Node, which is
 * the most reliable candidate. `PI_MARKET_BIN` overrides, and `pi` from PATH is
 * the final fallback (compiled binaries, wrappers).
 */
function piCommandCandidates(): PiCommand[] {
	const candidates: PiCommand[] = [];

	const override = process.env.PI_MARKET_BIN?.trim();
	if (override) candidates.push({ command: override, prefix: [] });

	const entry = process.argv[1];
	if (entry && existsSync(entry) && looksLikePiScript(entry)) {
		candidates.push({ command: process.execPath, prefix: [entry] });
	}

	candidates.push({ command: "pi", prefix: [] });
	return candidates;
}

function trustHint(source: string, output: string, scope: InstallScope): string {
	if (scope !== "project" || !/not trusted|--approve/i.test(output)) return output;
	return `${output}\n\nProject-local packages need explicit approval. Either run the command in a terminal with --approve:\n  pi install ${source} --local --approve\nor switch the market scope to "user" (ctrl+l).`;
}

const ANSI_PATTERN =
	// eslint-disable-next-line no-control-regex
	/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function cleanOutput(output: string, maxLines = 12): string {
	const stripped = output.replace(ANSI_PATTERN, "").replace(/\r/g, "");
	const lines = stripped
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0);
	if (lines.length <= maxLines) return lines.join("\n");
	return lines.slice(-maxLines).join("\n");
}

function abortError(): Error {
	return new Error("Aborted");
}

async function runPiCommand(
	pi: ExtensionAPI,
	args: string[],
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ ok: boolean; output: string }> {
	const errors: string[] = [];

	for (const candidate of piCommandCandidates()) {
		if (options.signal?.aborted) throw abortError();
		try {
			const result = await pi.exec(candidate.command, [...candidate.prefix, ...args], {
				signal: options.signal,
				timeout: options.timeoutMs ?? 300_000,
				cwd: process.cwd(),
			});
			const output = cleanOutput([result.stdout, result.stderr].filter(Boolean).join("\n"));
			if (result.code === 0) return { ok: true, output };
			if (result.killed && options.signal?.aborted) throw abortError();
			return {
				ok: false,
				output: output || `pi exited with code ${result.code ?? "unknown"}`,
			};
		} catch (error) {
			if (options.signal?.aborted) throw abortError();
			const message = error instanceof Error ? error.message : String(error);
			// Only try the next candidate when the executable could not be started.
			if (!/ENOENT|not found|spawn/i.test(message)) {
				return { ok: false, output: message };
			}
			errors.push(`${candidate.command}: ${message}`);
		}
	}

	return { ok: false, output: `Could not run the pi CLI.\n${errors.join("\n")}` };
}

function scopeFlag(scope: InstallScope): string[] {
	return scope === "project" ? ["--local"] : [];
}

export async function installPackageSource(
	pi: ExtensionAPI,
	source: string,
	scope: InstallScope,
	signal?: AbortSignal,
): Promise<InstallOutcome> {
	const normalized = packageSource(source);
	try {
		const result = await runPiCommand(pi, ["install", normalized, ...scopeFlag(scope)], { signal });
		if (!result.ok) {
			return {
				ok: false,
				source: normalized,
				scope,
				message: `Install failed for ${normalized}\n${trustHint(normalized, result.output, scope)}`,
			};
		}
		return {
			ok: true,
			source: normalized,
			scope,
			message: `Installed ${normalized} (${scope})`,
		};
	} catch (error) {
		const aborted = signal?.aborted === true;
		return {
			ok: false,
			source: normalized,
			scope,
			message: aborted ? `Cancelled ${normalized}` : `Install failed for ${normalized}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export async function removePackageSource(
	pi: ExtensionAPI,
	source: string,
	scope: InstallScope,
	signal?: AbortSignal,
): Promise<InstallOutcome> {
	const normalized = packageSource(source);
	try {
		const result = await runPiCommand(pi, ["remove", normalized, ...scopeFlag(scope)], { signal });
		if (!result.ok) {
			return {
				ok: false,
				source: normalized,
				scope,
				message: `Remove failed for ${normalized}\n${trustHint(normalized, result.output, scope)}`,
			};
		}
		return {
			ok: true,
			source: normalized,
			scope,
			message: `Removed ${normalized} (${scope})`,
		};
	} catch (error) {
		const aborted = signal?.aborted === true;
		return {
			ok: false,
			source: normalized,
			scope,
			message: aborted ? `Cancelled remove of ${normalized}` : `Remove failed for ${normalized}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
