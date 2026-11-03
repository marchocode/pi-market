/**
 * Dev helper: print the parsed catalog without the Pi TUI.
 *
 *   node scripts/preview.ts            # parse live gallery
 *   node scripts/preview.ts --cached   # use the on-disk cache
 *   node scripts/preview.ts --query pi # filter results
 */
import { formatAge, formatDownloads, loadCatalog, readCachedCatalog, searchPackages } from "../src/catalog.ts";

const args = process.argv.slice(2);
const useCache = args.includes("--cached");
const queryIndex = args.indexOf("--query");
const query = queryIndex >= 0 ? args[queryIndex + 1] : undefined;

if (useCache) {
	const cached = await readCachedCatalog();
	if (!cached) {
		console.error("No cache yet. Run: node scripts/preview.ts");
		process.exit(1);
	}
	print(cached.packages, cached.fetchedAt);
} else {
	const started = Date.now();
	let lastShown = 0;
	const snapshot = await loadCatalog({
		force: args.includes("--force"),
		onProgress: (progress) => {
			const now = Date.now();
			if (now - lastShown < 500 && progress.loadedPages !== progress.totalPages) return;
			lastShown = now;
			process.stderr.write(
				`\rfetched ${progress.loadedPages}/${progress.totalPages} pages · ${progress.packages} packages`,
			);
		},
	});
	process.stderr.write("\n");
	console.log(
		`\n${snapshot.packages.length} packages (gallery total ${snapshot.total}) in ${Date.now() - started}ms` +
			` · ${formatAge(snapshot.fetchedAt)}${snapshot.partial ? " · PARTIAL" : ""}\n`,
	);
	print(snapshot.packages, snapshot.fetchedAt);
}

function print(
	packages: Awaited<ReturnType<typeof loadCatalog>>["packages"],
	fetchedAt: number,
) {
	const results = searchPackages(packages, { query, limit: query ? 20 : 10 });
	for (const pkg of results) {
		console.log(
			`${pkg.name}  [${pkg.types.join(",")}]  ${formatDownloads(pkg)}  ${pkg.updatedLabel || ""}  ${pkg.source}`,
		);
		console.log(`  ${pkg.description}`);
		console.log(`  ${pkg.author} · https://pi.dev${pkg.path}`);
	}
	console.log(`\ncache: ${new Date(fetchedAt).toISOString()} · types: ${packages.length}`);
}
