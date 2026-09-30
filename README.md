# Wayback Machine

A Vineyard **plugin pack** that queries the Internet Archive Wayback Machine for the
selected domain or URL — capture history via the **CDX API** and existence checks via
the **Availability API**.

**Desktop only.** Neither `web.archive.org` nor `archive.org` sends
CORS headers, so a browser cannot read the responses. In the web build the plugin says so
rather than half-working.

## Plugins

- **Wayback Snapshot History** (`run.vineyard.plugins.wayback_snapshot_history`) — queries
  the CDX API and writes up to 50 captures as `web.url` nodes pointing at their
  replay pages (`https://web.archive.org/web/{timestamp}/{original}`), each linked to the
  seed node with a `has archive` edge. Captures carry `wayback_timestamp`,
  `wayback_digest`, and `wayback_mimetype` in node data.
  - `from` / `to` (`YYYYMMDD`) — restrict the capture window. Empty = unbounded.
  - `limit` — max captures (default 50, up to 500). Newest N are fetched, then written
    oldest → newest so the graph reads as a timeline.
  - `drop_duplicates` (checkbox, default on) — drops captures whose content **digest**
    repeats an earlier one. Identical snapshots are usually the same page re-crawled, not
    a real change; leaving this on keeps the timeline to actual content states.

- **Wayback Availability** (`run.vineyard.plugins.wayback_available`) — asks the
  Availability API whether a closest snapshot exists and records the result on the node
  itself (`wayback_available`, `wayback_snapshot_url`, `wayback_snapshot_timestamp`,
  `wayback_snapshot_status`). A fast "is this archived at all?" check.

## How it works

Response bodies are capped (4 MB for CDX, 64 KB for availability), and every non-200 /
non-JSON / rate-limited response becomes a readable summary instead of an exception.

## Layout

- `plugins/wayback-machine.manifest.json` — the pack manifest (catalog entry source).
- `dist/pack.mjs` — the runnable bundle.

## License

Apache-2.0
