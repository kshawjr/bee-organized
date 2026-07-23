// lib/import-sample.ts
// ─────────────────────────────────────────────────────────────
// Sample selection for the sample-now / bulk-later onboarding import.
//
// Selection happens at WRITE time over fully-staged data — every client and
// every child is already in memory (the fetch phase stages everything;
// children can't be fetched per-client cheaply, the entity queries are flat
// full scans) — so Jobber's sort/filter capabilities are irrelevant here.
//
// Two lanes, deduped, ~75 total:
//   • newest N by client.createdAt — the names the owner recognizes from
//     this week and will want to click on the call.
//   • most-recently-active M WITH history — ranked by the most recent child
//     timestamp (quote/job/invoice createdAt), requiring ≥1 such child.
//
// Why not newest-only: a location's newest clients skew toward bare fresh
// requests that render as thin cards. Children are what make a record look
// real — vitals, timeline, money — so history-weighted selection is what
// makes the Hub look ALIVE on the call.
//
// Pure functions, no imports with side effects (client-safe, unit-tested
// like selectUnwrittenClients).
// ─────────────────────────────────────────────────────────────

export const SAMPLE_NEWEST_COUNT = 25
export const SAMPLE_ACTIVE_COUNT = 50

type ChildMaps = {
  /** client node id → its service requests (route's reqByClient) */
  reqByClient: Record<string, any[]>
  /** request node id → quotes (route's quotesByReq) */
  quotesByReq: Record<string, any[]>
  /** request node id → jobs, each with nested invoices (route's jobsByReq) */
  jobsByReq: Record<string, any[]>
  /** client node id → requestless quotes */
  reqlessQuotesByClient: Record<string, any[]>
  /** client node id → requestless jobs (nested invoices ride along) */
  reqlessJobsByClient: Record<string, any[]>
}

/**
 * Most recent CHILD activity per client (ms), from the exact lookup maps the
 * write phase already builds. Only quotes/jobs/invoices count — a bare
 * service request is not "history" (it renders as a thin card). A client
 * with no such child has no entry, which is what the active lane keys on.
 */
export function buildLastChildActivity(
  clients: Array<{ id?: string | null }>,
  maps: ChildMaps,
): Map<string, number> {
  const ts = (v: any): number => {
    const t = v ? Date.parse(v) : NaN
    return Number.isFinite(t) ? t : 0
  }
  const out = new Map<string, number>()
  for (const c of clients) {
    const cid = c.id
    if (!cid) continue
    let last = 0
    const consider = (v: any) => { const t = ts(v); if (t > last) last = t }
    const jobAndInvoices = (j: any) => {
      consider(j?.createdAt)
      for (const inv of j?.invoices?.nodes || []) consider(inv?.createdAt)
    }
    for (const r of maps.reqByClient[cid] || []) {
      for (const q of maps.quotesByReq[r.id] || []) consider(q?.createdAt)
      for (const j of maps.jobsByReq[r.id] || []) jobAndInvoices(j)
    }
    for (const q of maps.reqlessQuotesByClient[cid] || []) consider(q?.createdAt)
    for (const j of maps.reqlessJobsByClient[cid] || []) jobAndInvoices(j)
    if (last > 0) out.set(String(cid), last)
  }
  return out
}

/**
 * Pick the sample slice. Input is the route's `unwritten` array (so a sample
 * segment that resumes after a mid-flight death re-selects from what's left).
 * Returns the picks sorted newest-client-first, matching the write loop's
 * standing order so recent clients still land first if a segment dies.
 *
 * When clients.length ≤ newest+active the whole set comes back — a small
 * location's "sample" is everyone, the segment finds nothing remaining, and
 * the import completes normally instead of parking.
 */
export function selectSampleClients<T extends { id?: string | null; createdAt?: string | null }>(
  clients: T[],
  lastChildActivity: Map<string, number>,
  opts: { newestCount?: number; activeCount?: number } = {},
): T[] {
  const newestCount = opts.newestCount ?? SAMPLE_NEWEST_COUNT
  const activeCount = opts.activeCount ?? SAMPLE_ACTIVE_COUNT
  const created = (c: T): number => {
    const t = c.createdAt ? Date.parse(c.createdAt) : NaN
    return Number.isFinite(t) ? t : 0
  }

  // Small location: the whole book fits inside the sample target — take
  // everyone (newest-first). The segment then has no remainder and the
  // import completes normally instead of parking.
  if (clients.length <= newestCount + activeCount) {
    return [...clients].sort((a, b) => created(b) - created(a))
  }

  const byNewest = [...clients].sort((a, b) => created(b) - created(a))
  const picked = new Map<string, T>()
  const keyOf = (c: T, i: number) => (c.id != null ? String(c.id) : `__noid_${i}`)

  for (let i = 0; i < byNewest.length && picked.size < newestCount; i++) {
    picked.set(keyOf(byNewest[i], i), byNewest[i])
  }

  const active = clients
    .filter((c) => c.id != null && lastChildActivity.has(String(c.id)))
    .sort(
      (a, b) =>
        (lastChildActivity.get(String(b.id)) || 0) - (lastChildActivity.get(String(a.id)) || 0),
    )
  let added = 0
  for (const c of active) {
    if (added >= activeCount) break
    const k = String(c.id)
    if (picked.has(k)) continue
    picked.set(k, c)
    added++
  }

  return Array.from(picked.values()).sort((a, b) => created(b) - created(a))
}
