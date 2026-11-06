// Wayback Machine pack — query the Internet Archive's CDX + Availability APIs for a
// domain/URL's capture history and write the timeline into the graph.
//
// Why `web_probe` (desktop only): neither web.archive.org nor archive.org sends
// `access-control-allow-origin`, so a browser cannot read the responses. The Electron
// shell's main process has no same-origin policy, so each query goes out through
// `ctx.net.probe` — anonymous, SSRF-guarded, no redirects. In a browser the capability
// is absent and the plugin says so rather than half-working (same pattern as whatsmyname).
//
// Two plugins in this pack:
//   1. wayback_snapshot_history — CDX API: list up to N captures (optionally within
//      from/to), write each as a web.url node pointing at the replay URL,
//      deduplicated by digest when the analyst checks "drop duplicates".
//   2. wayback_available — Availability API: whether the closest snapshot exists, written
//      back onto the node's own data (node:update only).
import { definePlugin, definePluginPack } from './sdk';
import type { HostContext, RunResult, GraphNode } from './sdk';

// ── endpoints ───────────────────────────────────────────────────────────────────

const CDX_BASE = 'https://web.archive.org/cdx/search/cdx';
const AVAIL_BASE = 'https://archive.org/wayback/available';

// Replay URL shape: https://web.archive.org/web/{timestamp}/{original}
const replayUrl = (timestamp: string, original: string) => `https://web.archive.org/web/${timestamp}/${original}`;

/**
 * Host of a captured URL.
 *
 * The `domain` field used to be filled with this plugin's QUERY target, which is a hostname only
 * when the seed was a domain node — seed a web.url instead and every capture recorded the whole
 * seed URL as its domain (`https://github.com/user/repo` in a field called domain). The capture's
 * own `original` is the right source for both seed types, so no branch on the seed is needed.
 *
 * Defensive about the scheme: CDX normally returns one, but a bare host would otherwise parse as a
 * relative URL and throw.
 */
export function hostOf(url: string): string | undefined {
    try {
        const abs = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
        return new URL(abs).hostname || undefined;
    } catch {
        return undefined;
    }
}

// ── CDX parsing ────────────────────────────────────────────────────────────────

interface CdxRow {
    timestamp: string;
    original: string;
    statuscode: string;
    mimetype: string;
    digest: string;
}

/**
 * CDX returns a JSON array of arrays: the first row is the header
 * (`["timestamp","original","statuscode","mimetype","digest"]`), every row after is
 * data. We request `fl=` explicitly so the order is pinned, but we still map by header
 * name rather than index — a server that reorders columns should not corrupt the graph.
 */
function parseCdx(body: string): CdxRow[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed) || parsed.length < 2) return [];
    const header = parsed[0];
    if (!Array.isArray(header)) return [];
    const idx = (name: string) => header.indexOf(name);
    const iTs = idx('timestamp');
    const iOrig = idx('original');
    const iStatus = idx('statuscode');
    const iMime = idx('mimetype');
    const iDigest = idx('digest');
    if (iTs < 0 || iOrig < 0) return [];

    const rows: CdxRow[] = [];
    for (let i = 1; i < parsed.length; i++) {
        const r = parsed[i];
        if (!Array.isArray(r)) continue;
        rows.push({
            timestamp: String(r[iTs] ?? ''),
            original: String(r[iOrig] ?? ''),
            statuscode: iStatus >= 0 ? String(r[iStatus] ?? '') : '',
            mimetype: iMime >= 0 ? String(r[iMime] ?? '') : '',
            digest: iDigest >= 0 ? String(r[iDigest] ?? '') : '',
        });
    }
    return rows;
}

/** Safe URL building: only a scheme+host we control, query params encoded. */
export function cdxUrl(target: string, from: string, to: string, limit: number): string {
    const u = new URL(CDX_BASE);
    u.searchParams.set('url', target);
    u.searchParams.set('output', 'json');
    u.searchParams.set('fl', 'timestamp,original,statuscode,mimetype,digest');
    // Negative: CDX returns the LAST N captures. A positive limit returns the first (oldest) N.
    u.searchParams.set('limit', String(-limit));
    if (from) u.searchParams.set('from', from);
    if (to) u.searchParams.set('to', to);
    return u.toString();
}

function availUrl(target: string): string {
    const u = new URL(AVAIL_BASE);
    u.searchParams.set('url', target);
    return u.toString();
}

/** Does this node carry a value we can query Wayback for? */
function waybackTarget(seed: GraphNode): string | null {
    const d = (seed.data ?? {}) as Record<string, unknown>;
    if (seed.type === 'web.url') {
        const v = d.url;
        return typeof v === 'string' && v ? v : null;
    }
    if (seed.type === 'infrastructure.domain') {
        const v = d.domain_name;
        return typeof v === 'string' && v ? v : null;
    }
    return null;
}

// ── plugin 1: snapshot history (CDX) ───────────────────────────────────────────

const snapshotHistory = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.wayback_snapshot_history',
        content_type: 'vineyard:plugin',
        name: 'Wayback Snapshot History',
        version: '1.2.2',
        description:
            'Lists Wayback Machine captures of each selected Domain or URL and creates one URL node per capture (replay URL, original URL, HTTP status, timestamp, digest) linked "has archive" from the seed. Up to limit captures per node (default 50, max 500), filtered by the from/to and drop_duplicates params. Desktop only.',
        icon: 'history',
        author: { name: 'VINEYARD', url: 'https://vineyard.run' },
        license: 'Apache-2.0',
        platforms: {
            primary: 'desktop',
            web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
            desktop: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
        },
        io: {
            consumes: [
                { typepack: 'run.vineyard.typepacks.infrastructure', category: 'infrastructure', name: 'domain' },
                { typepack: 'run.vineyard.typepacks.infrastructure', category: 'web', name: 'url' },
            ],
            produces: [{ typepack: 'run.vineyard.typepacks.infrastructure', category: 'web', name: 'url' }],
        },
        params: {
            type: 'object',
            properties: {
                from: {
                    type: 'string',
                    pattern: '^\\d{8}$',
                    description: 'Earliest capture date, YYYYMMDD. Empty = no lower bound.',
                },
                to: {
                    type: 'string',
                    pattern: '^\\d{8}$',
                    description: 'Latest capture date, YYYYMMDD. Empty = no upper bound.',
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 500,
                    default: 50,
                    description: 'Maximum captures to fetch per node, 1–500. Default 50.',
                },
                drop_duplicates: {
                    type: 'boolean',
                    default: true,
                    description: 'Keep only the newest capture of each content digest. On by default.',
                },
            },
        },
        scopes: {
            graph: ['node:read', 'node:create', 'edge:create'],
            web_probe: {
                purpose: 'Fetch the Wayback Machine capture history of each selected domain or URL.',
            },
        },
        lifecycle: { persistence: 'opt-in', controls: ['progress', 'cancel'], progress: 'determinate' },
    },

    async run(ctx: HostContext): Promise<RunResult> {
        const ids = ctx.input.selection;
        if (!ids.length) {
            return { summary: 'Select a Domain or URL node first', counts: { created: 0 } };
        }
        if (!ctx.net?.probe) {
            return {
                summary:
                    'Wayback queries need the desktop shell (web.archive.org sends no CORS headers, so a browser cannot read the response). Run this plugin in the desktop app.',
                counts: { created: 0 },
            };
        }

        const p = ctx.params ?? {};
        const from = typeof p.from === 'string' ? p.from.trim() : '';
        const to = typeof p.to === 'string' ? p.to.trim() : '';
        const limit = Math.min(500, Math.max(1, typeof p.limit === 'number' ? Math.floor(p.limit) : 50));
        const dropDup = p.drop_duplicates !== false;

        let created = 0;
        let skipped = 0;
        let queried = 0;
        let noTarget = 0;
        let notFound = 0;
        let lastTarget = '';
        // Each node is an independent CDX query (a different target), so there is nothing to hoist
        // out of the loop the way the disposable-email blocklist fetch is — the cost genuinely
        // scales with the selection, and that is reported honestly rather than papered over.
        for (let n = 0; n < ids.length; n++) {
            if (ctx.signal?.aborted) {
                return {
                    summary: `Cancelled after ${queried}/${ids.length} node(s) (${created} capture(s) written)`,
                    counts: { created, skipped, queried, no_target: noTarget, not_found: notFound },
                };
            }
            const seed = await ctx.graph!.get!(ids[n]);
            if (!seed) {
                notFound++;
                continue;
            }
            const target = waybackTarget(seed);
            if (!target) {
                noTarget++;
                continue;
            }
            lastTarget = target;

            ctx.progress?.set?.({
                percent: Math.round((100 * n) / ids.length),
                message: ids.length > 1 ? `Querying ${target} (${n + 1}/${ids.length})…` : `Querying ${target}…`,
            });
            const res = await ctx.net.probe(cdxUrl(target, from, to, limit), {
                method: 'GET',
                maxBytes: 4 * 1024 * 1024,
            });
            queried++;
            if (res.error || res.status === 0) continue; // one node's transport failure must not sink the rest
            if (res.status === 429) {
                // The whole endpoint is rate-limited, not just this node's request — continuing
                // would just fail the same way on every remaining node while burning the analyst's
                // time watching it happen.
                return {
                    summary: `Wayback rate-limited the request (429) after ${queried - 1}/${
                        ids.length
                    } node(s). Try again shortly.`,
                    counts: { created, skipped, queried: queried - 1, no_target: noTarget, not_found: notFound },
                };
            }
            if (res.status !== 200) continue;

            let rows = parseCdx(res.body ?? '');
            if (!rows.length) continue;

            // CDX returns the latest N (negative limit) in capture order; sort newest-first and cap,
            // then reverse for a timeline when writing.
            rows.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
            rows = rows.slice(0, limit);
            if (dropDup) {
                const seen = new Set<string>();
                rows = rows.filter((r) => {
                    if (!r.digest) return true; // no digest → can't judge, keep it
                    if (seen.has(r.digest)) return false;
                    seen.add(r.digest);
                    return true;
                });
            }
            // oldest → newest so the graph reads as a timeline left-to-right
            rows.reverse();

            for (const r of rows) {
                if (ctx.signal?.aborted) break;
                const node = await ctx.graph!.createNode!({
                    type: 'web.url',
                    data: {
                        url: replayUrl(r.timestamp, r.original),
                        domain: hostOf(r.original),
                        // The archived URL, which is otherwise only readable by splitting it back
                        // out of the replay URL this node is labelled with.
                        original_url: r.original,
                        http_status: r.statuscode ? Number(r.statuscode) : undefined,
                        page_title: `Wayback capture ${r.timestamp}`,
                        final_url: replayUrl(r.timestamp, r.original),
                        wayback_timestamp: r.timestamp,
                        wayback_digest: r.digest || undefined,
                        wayback_mimetype: r.mimetype || undefined,
                    },
                });
                if (!node) {
                    skipped++;
                    continue;
                }
                created++;
                await ctx.graph!.createEdge!({ from: String(seed.id), to: String(node.id), label: 'has archive' });
            }
            ctx.progress?.set?.({
                percent: Math.round((100 * (n + 1)) / ids.length),
                message: `${created} capture(s) so far`,
            });
        }

        const skipNote = noTarget || notFound ? ` (${noTarget + notFound} node(s) skipped: no url/domain_name)` : '';
        return {
            summary:
                queried <= 1
                    ? `Found ${created} capture(s) for ${lastTarget}${dropDup ? ' (duplicates dropped)' : ''}`
                    : `${created} capture(s) across ${queried} node(s)${
                          dropDup ? ' (duplicates dropped)' : ''
                      }${skipNote}`,
            counts: { created, skipped, queried, no_target: noTarget, not_found: notFound },
        };
    },
});

// ── plugin 2: availability (single closest snapshot) ───────────────────────────

const availability = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.wayback_available',
        content_type: 'vineyard:plugin',
        name: 'Wayback Availability',
        version: '1.2.2',
        description:
            'Checks whether the Wayback Machine has a capture of each selected Domain or URL and writes the result on the node: wayback_available, plus wayback_snapshot_url, wayback_snapshot_timestamp and wayback_snapshot_status of the closest capture. Creates no nodes. Desktop only.',
        icon: 'circle-check',
        author: { name: 'VINEYARD', url: 'https://vineyard.run' },
        license: 'Apache-2.0',
        platforms: {
            primary: 'desktop',
            web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
            desktop: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
        },
        io: {
            consumes: [
                { typepack: 'run.vineyard.typepacks.infrastructure', category: 'infrastructure', name: 'domain' },
                { typepack: 'run.vineyard.typepacks.infrastructure', category: 'web', name: 'url' },
            ],
            produces: [],
        },
        scopes: {
            graph: ['node:read', 'node:update'],
            web_probe: {
                purpose: 'Check whether the Wayback Machine has a capture of each selected domain or URL.',
            },
        },
        lifecycle: { persistence: 'opt-in', controls: ['progress', 'cancel'], progress: 'determinate' },
    },

    async run(ctx: HostContext): Promise<RunResult> {
        const ids = ctx.input.selection;
        if (!ids.length) {
            return { summary: 'Select a Domain or URL node first', counts: { checked: 0 } };
        }
        if (!ctx.net?.probe) {
            return {
                summary:
                    'Availability queries need the desktop shell (archive.org sends no CORS headers). Run this plugin in the desktop app.',
                counts: { checked: 0 },
            };
        }

        let checked = 0;
        let available = 0;
        let noTarget = 0;
        let notFound = 0;
        let lastTarget = '';
        let lastAvailable = false;
        let lastSnapshotTimestamp = '';
        for (let i = 0; i < ids.length; i++) {
            if (ctx.signal?.aborted) {
                return {
                    summary: `Cancelled after ${checked}/${ids.length} node(s)`,
                    counts: { checked, available, no_target: noTarget, not_found: notFound },
                };
            }
            const seed = await ctx.graph!.get!(ids[i]);
            if (!seed) {
                notFound++;
                continue;
            }
            const target = waybackTarget(seed);
            if (!target) {
                noTarget++;
                continue;
            }

            ctx.progress?.set?.({
                percent: Math.round((100 * i) / ids.length),
                message: ids.length > 1 ? `Checking ${target} (${i + 1}/${ids.length})…` : `Checking ${target}…`,
            });
            const res = await ctx.net.probe(availUrl(target), { method: 'GET', maxBytes: 64 * 1024 });
            if (res.error || res.status === 0) continue; // one node's failure must not sink the rest
            if (res.status === 429) {
                return {
                    summary: `Availability API rate-limited the request (429) after ${checked}/${ids.length} node(s). Try again shortly.`,
                    counts: { checked, available, no_target: noTarget, not_found: notFound },
                };
            }
            if (res.status !== 200) continue;

            let data: Record<string, unknown> = {};
            try {
                data = JSON.parse(res.body ?? '{}');
            } catch {
                continue;
            }
            const closest = (data?.archived_snapshots as any)?.closest;
            const isAvailable = !!(closest && closest.available === true);

            const update: Record<string, unknown> = {
                wayback_checked_at: new Date().toISOString(),
                wayback_available: isAvailable,
            };
            if (isAvailable && closest) {
                update.wayback_snapshot_url = String(closest.url ?? '');
                update.wayback_snapshot_timestamp = String(closest.timestamp ?? '');
                update.wayback_snapshot_status = closest.status != null ? String(closest.status) : undefined;
            }

            // `data` here is the patch object merged at the node's data TOP LEVEL — the same
            // level as `email`, `domain`, etc. — so wayback_* lands as data.wayback_*.
            // (Wrapping it as { data: update } would create a nested data.data object that
            // the server stringifies as "[Object Object]" — same bug as disposable-email.)
            await ctx.graph!.updateNode!(String(seed.id), update);
            checked++;
            if (isAvailable) available++;
            lastTarget = target;
            lastAvailable = isAvailable;
            lastSnapshotTimestamp = String(closest?.timestamp ?? '');
        }

        const skipNote = noTarget || notFound ? ` (${noTarget + notFound} node(s) skipped: no url/domain_name)` : '';
        return {
            summary:
                checked === 1
                    ? lastAvailable
                        ? `Archived — closest snapshot ${lastSnapshotTimestamp}`
                        : `No capture found in the Wayback Machine for ${lastTarget}`
                    : `${available} of ${checked} node(s) archived${skipNote}`,
            counts: { checked, available, no_target: noTarget, not_found: notFound },
        };
    },
});

export default definePluginPack({
    identifier: 'run.vineyard.pluginpacks.wayback_machine',
    content_type: 'vineyard:pluginpack',
    name: 'Wayback Machine',
    version: '1.2.2',
    description:
        'Queries the Internet Archive Wayback Machine for the capture history and archive availability of selected domains and URLs. Desktop only.',
    plugins: [snapshotHistory, availability],
});
