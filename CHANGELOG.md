# Changelog

## 0.1.0 - 2026-11-03

Initial release.

- `/market` interactive browser for https://pi.dev/packages with fuzzy search,
  type filter, sort, user/project scope toggle, and mouse click installation.
- Crawls and parses the full gallery (~5,700 packages) with progress, retries,
  and a 6-hour on-disk cache.
- `market_search` and `market_install` tools for the model.
- Installs/removes packages through the `pi` CLI, with installed-state markers
  and a reload prompt after changes.
