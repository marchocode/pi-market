# pi-market

[English](README.md) | [简体中文](README_zh.md)

[![npm version](https://img.shields.io/npm/v/pi-market.svg)](https://www.npmjs.com/package/pi-market)
[![license](https://img.shields.io/npm/l/pi-market.svg)](LICENSE)

Browse the [pi.dev/packages](https://pi.dev/packages) market directly inside Pi: search packages, inspect details, and install extensions, skills, themes, and prompt packages with one click.

```
 Pi Market pi.dev/packages                                    5,748 packages · 2m ago
 / powerline
 type all · sort downloads · scope user · show 14/5,748
 ──────────────────────────────────────────────────────────────────────────────────────
 ▸ pi-powerline-footer                              50.5K/mo│pi-powerline-footer
   pi-powerline                                         877/mo│nicopreme · 50.5K/mo · 4d ago
   @talex-touch/pi-powerline-footer                     255/mo│extension · not installed
   @lokiyou/pi-nano-footer                            2,748/mo│
   pi-tui-status-beautifier                           1,826/mo│Powerline-style status bar extension for pi coding
   @underactive/pi-topping-statusline                 1,482/mo│agent
   @juanibiapina/pi-powerbar                          1,198/mo│
   @groeponline/pi-wishcraft                           853/mo│$ pi install npm:pi-powerline-footer
   @wishx127/pi-tokyo-night                             764/mo│https://pi.dev/packages/pi-powerline-footer
   ────────────────────────────────────────────────────────────────────────────────────
   ↑↓ move · ⏎ install · ctrl+r remove · ctrl+l scope · ctrl+t type · tab sort · esc close
```

## Installation

Install from npm:

```bash
pi install npm:pi-market
```

Local development / trial:

```bash
git clone git@github.com:marchocode/pi-market.git
cd pi-market
pi -e ./src/index.ts        # Load only for this run
# or
pi install ./               # Write to settings and load on every start
```

After installing, run `/reload` or restart Pi.

## Usage

### `/market` — Interactive market

| Action | Description |
| --- | --- |
| Type directly | Live filtering with multiple keywords; matches names first, then description/author/keywords |
| `↑` / `↓` | Move selection (mouse wheel works too) |
| `Enter` | Install the selected package (using the current scope) |
| **Mouse click** | Click any row to install that package (fullscreen mode) |
| `ctrl+r` | Remove an installed package; press twice to confirm |
| `ctrl+l` | Toggle install scope: `user` (global) ⇄ `project` (`.pi/settings.json`) |
| `ctrl+t` | Toggle type filter: all / extension / skill / theme / prompt |
| `Tab` | Toggle sort: downloads / recently updated / name |
| `Esc` | Clear search; closes the market when the search is empty |
| `Enter` (after closing) | If anything was installed or removed, asks whether to `/reload` now |

### Other commands

```bash
/market                      # Open the interactive market
/market <keyword>            # Open the market with a search query
/market search <keyword>     # Print matching results directly (works outside the TUI)
/market refresh              # Force-refresh the market catalog
/market install <name> [-l]  # Install directly; -l installs into the project (.pi/settings.json)
/market help                 # Show help
```

### Tools for the model

- `market_search` — Search the market catalog and return the package name, description, install command, and installed status
- `market_install` — Run `pi install` (asks for confirmation in interactive mode)

## Data and cache

- The catalog comes from the server-rendered HTML at `https://pi.dev/packages` (~115 pages). The first open fetches pages concurrently and shows progress.
- Parsed results are cached at `~/.pi/agent/cache/pi-market/catalog.json` (6-hour TTL by default; 10 minutes when the catalog is partially fetched).
- `/market refresh` forces a refresh at any time; network errors are shown in the TUI with `Enter` to retry.
- Installed status is read from `~/.pi/agent/settings.json` and `.pi/settings.json` in the current directory.

## What installation actually runs

`pi-market` does not edit settings directly; it invokes the Pi CLI:

```bash
pi install npm:<name>            # user scope
pi install npm:<name> --local    # project scope
pi remove  npm:<name> [--local]
```

This keeps version pinning, npm/git source handling, and the settings format identical to manual installs.

Security note: Pi extensions run with your system permissions, so only install packages you trust. Project-local installs are protected by Pi's project trust mechanism; when the project is untrusted, the market suggests using manual `--approve` or switching to user scope.

## Development

```bash
npm install            # Install TypeScript (type-checking only)
npm run typecheck      # tsc --noEmit
npm test               # Parser/search/source-normalization unit tests
npm run preview        # Print the catalog without the TUI (supports --cached / --query)
```

The extension entry point is `src/index.ts`. jiti loads TypeScript directly, so no build step is needed.

## Publishing (maintainers)

```bash
npm login
npm run typecheck && npm test
npm version patch        # Bump the version and create a git tag
git push --follow-tags   # Pushing the tag triggers GitHub Actions
```

GitHub Actions (`.github/workflows/publish.yml`) runs
`npm publish --provenance --access public` when a `v*` tag is pushed. Configure
`NPM_TOKEN` in the repository secrets (an npm Automation token).

Manual publish:

```bash
npm publish --access public
```

## License

MIT
