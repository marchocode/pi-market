# pi-market

[English](README.md) | [简体中文](README_zh.md)

[![npm version](https://img.shields.io/npm/v/pi-market.svg)](https://www.npmjs.com/package/pi-market)
[![license](https://img.shields.io/npm/l/pi-market.svg)](LICENSE)

Browse the [pi.dev/packages](https://pi.dev/packages) market directly inside Pi: search packages, inspect details, and install extensions, skills, themes, and prompt packages with one click.

```
Pi Market pi.dev/packages                                                   5,649 packages · 2m ago
/   type to filter · package name, description, author
type all · sort downloads · scope user · show 5,649/5,649
────────────────────────────────────────────────────────────────────────────────────────────────────
▸ billion-context                                2.8M/mo│billion-context
  pi-mcp-adapter                                 1.4M/mo│ranxianglei · 2.8M/mo · 2d ago
  pi-web-access                           1.1M/mo ✓user │package · not installed
  pi-mcp-extension                             823.8K/mo│
  pi-subagents                          726.4K/mo ✓user │A context-compression plugin — small
  @postman/postman-plugin                        426K/mo│context windows (a 100K context is enough),
  openwiki                                     209.9K/mo│5x fewer tokens, month-long single sessions
  @juicesharp/rpiv-ask-user-question           149.3K/mo│(billions of tokens), and compression
  @dietrichgebert/ponytail                     130.6K/mo│quality — for all agents: pi, OpenCode,
  cc-safety-net                                108.5K/mo│Codex, Claude Code, and more.
  context-mode                                 103.9K/mo│billion-context is all
  @langchain/langsmith-pi-extension             96.1K/mo│
  @plannotator/pi-extension                     89.7K/mo│$ pi install npm:billion-context
  @juicesharp/rpiv-todo                         87.4K/mo│https://pi.dev/packages/billion-context
  @onkernel/browser-loop                        86.4K/mo│
  1-15 of 5,649
────────────────────────────────────────────────────────────────────────────────────────────────────
↑↓ move · ⏎ install · ctrl+r remove · ctrl+l scope · ctrl+t type · tab sort · esc close
```

Wide terminals show the package list on the left and the selected package's details on the right; narrow terminals stack that summary under the list. Each row shows the package name, its monthly download count, and a `✓user` / `✓project` badge when it is already installed; the footer reports the visible range, e.g. `1-15 of 5,649`.

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

- The catalog comes from the server-rendered HTML at `https://pi.dev/packages` (~113 pages). The first open fetches pages concurrently and shows progress.
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

## License

MIT
