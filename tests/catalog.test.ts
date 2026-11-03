import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCatalogPage, searchPackages, sortPackages } from "../src/catalog.ts";
import { npmPackageName, packageSource } from "../src/install.ts";

const PAGE = `
<section>
	<div class="content-card-actions"><span class="packages-count">1-2 / 237</span></div>
	<div class="content-grid">
		<article class="surface-panel content-card" data-package-card="true"
			data-package-name="pi-powerline-footer"
			data-package-search="pi-powerline-footer powerline status bar nicopreme extension"
			data-package-types="extension"
			data-package-downloads="50535"
			data-package-date="1793284188113">
			<div class="packages-card-body">
				<h3 class="packages-name"><a href="/packages/pi-powerline-footer" data-package-path="/packages/pi-powerline-footer">pi-powerline-footer</a></h3>
				<p class="packages-desc">Powerline-style status bar &amp; footer</p>
				<div class="packages-meta"><span>nicopreme</span><span>50.5K/mo</span><span>4d ago</span></div>
				<div class="packages-badges"><span class="meta-chip packages-badge" data-type="extension">extension</span></div>
			</div>
		</article>
		<article data-package-card="true" data-package-name="@scope/evil"
			data-package-search="@scope/evil escape sequence test" data-package-types=""
			data-package-downloads="12">
			<p class="packages-desc">Bad \u001b[31mtext\u0007 and <b>markup</b></p>
			<div class="packages-meta"><span>someone</span><span>12/mo</span><span>1h ago</span></div>
		</article>
	</div>
	<nav class="pagination"><a href="/packages?page=2">2</a><a href="/packages?page=5">5</a></nav>
</section>`;

test("parses package cards, totals, and pagination", () => {
	const parsed = parseCatalogPage(PAGE);
	assert.equal(parsed.packages.length, 2);
	assert.equal(parsed.total, 237);
	assert.equal(parsed.totalPages, 5);

	const footer = parsed.packages[0]!;
	assert.equal(footer.name, "pi-powerline-footer");
	assert.equal(footer.description, "Powerline-style status bar & footer");
	assert.deepEqual(footer.types, ["extension"]);
	assert.equal(footer.downloads, 50535);
	assert.equal(footer.downloadsLabel, "50.5K/mo");
	assert.equal(footer.updatedLabel, "4d ago");
	assert.equal(footer.author, "nicopreme");
	assert.equal(footer.source, "npm:pi-powerline-footer");
	assert.equal(footer.path, "/packages/pi-powerline-footer");
	assert.equal(footer.publishedAt, 1793284188113);
});

test("plain packages get the package badge and control characters are stripped", () => {
	const plain = parseCatalogPage(PAGE).packages[1]!;
	assert.deepEqual(plain.types, ["package"]);
	assert.equal(plain.description, "Bad [31mtext and markup");
	assert.ok(!plain.searchText.includes("\u001b"));
});

test("search filters by token and type, and sorts", () => {
	const packages = parseCatalogPage(PAGE).packages;
	assert.equal(searchPackages(packages, { query: "powerline" }).length, 1);
	assert.equal(searchPackages(packages, { query: "powerline", type: "skill" }).length, 0);
	assert.equal(searchPackages(packages, { type: "all" }).length, 2);
	assert.equal(searchPackages(packages, { limit: 1 }).length, 1);
	assert.equal(sortPackages(packages, "downloads")[0]!.name, "pi-powerline-footer");
	assert.equal(sortPackages(packages, "name")[0]!.name, "@scope/evil");
});

test("normalizes npm sources for installed-state matching", () => {
	assert.equal(npmPackageName("npm:pi-subagents"), "pi-subagents");
	assert.equal(npmPackageName("npm:pi-subagents@1.2.3"), "pi-subagents");
	assert.equal(npmPackageName("npm:@scope/pkg"), "@scope/pkg");
	assert.equal(npmPackageName("npm:@scope/pkg@1.2.3"), "@scope/pkg");
	assert.equal(npmPackageName("git:github.com/user/repo"), undefined);
	assert.equal(packageSource("pi-subagents"), "npm:pi-subagents");
	assert.equal(packageSource("npm:@scope/pkg@1"), "npm:@scope/pkg@1");
	assert.equal(packageSource("./local"), "./local");
});
