// lib/client-search.ts
// ─────────────────────────────────────────────────────────────
// The Client List's server-side search (Clients at scale, slice 1).
//
// WHY: the Client List filters the people array the page loaded, and that
// load stops at 5,000 (app/_hub-page.tsx MAX_LEADS). At a location over the
// ceiling — Philadelphia Suburbs, 18,931 active clients — 13,931 people could
// not be found from that box at all. This reads the leads table directly, so
// every client is findable, and hands each hit back in the SAME Person shape
// the page load builds, so the screen files it in its real status band with
// the code it already uses (deriveClientStatus). Nothing here decides a band.
//
// WHAT IT MATCHES — the same four things the browser filter matches
// (components/hive/ClientGroupedList.jsx): name, email, phone as stored, and
// tag name. Deliberately NOT phone_normalized: the box has never matched
// "2155550199" against "(215) 555-0199", and a server that did would make the
// loaded and unloaded halves of one result list follow different rules.
//
// WHO IS IN IT — the Client List's rule, which is the page load's rule: not
// junk and not archived, through the shared applyLeadActiveFilter. ⌘K
// (app/api/search) deliberately includes archived clients; that is ITS rule
// and this file must not borrow it, nor the other way round.
//
// THE FENCE — the caller passes ONE location uuid that it has already
// authorised (resolveClientSearchScope below). Every leads read in this file
// carries .eq('location_uuid', …); child rows are only ever read for lead ids
// that came back through that fence.
//
// THE CAP — at most CLIENT_SEARCH_CAP people come back, newest first, with
// the exact total beside them, so a short list can never pass as a whole one.
// ─────────────────────────────────────────────────────────────

import { applyLeadActiveFilter } from './lead-suppression'
import { rollUpEngagements } from './engagement-rollup'
import { mapLeadToPerson } from './people-mapper'
import { TAG_CATEGORIES } from './tags'
import { liveJobs } from '@/components/hive/shared/jobDeleted'
import { liveInvoices } from '@/components/hive/shared/invoiceDeleted'

export const CLIENT_SEARCH_CAP = 200
export const CLIENT_SEARCH_MAX_TERM = 80
// Runaway guard on the tag half only: links for the matching tags are read
// tenant-wide before the location fence can be applied to their leads.
const TAG_LINK_MAX = 20000
const PAGE = 1000
const ID_CHUNK = 100

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// ── scope ────────────────────────────────────────────────────────────────────
// One location per search, decided on the server.
//   franchise roles (owner, manager, lite_user) — their own location, always.
//     A `location` parameter naming any OTHER location is refused outright
//     rather than quietly corrected: a forged id should fail loudly.
//     lite_user is read-only, and reading clients is what the page load
//     already gives them — same people, same fence, nothing wider.
//   elevated (super_admin, admin — the route decides with isAdmin) — the
//     location they name. The Client List
//     asks for a location before it renders for them, so there is always one.
export type ClientSearchScope =
  | { ok: true; locationUuid: string }
  | { ok: false; status: 400 | 403; error: string }

export function resolveClientSearchScope(
  hubUser: { elevated: boolean; location_id?: string | null },
  requestedLocation: string | null | undefined,
): ClientSearchScope {
  const requested = (requestedLocation || '').trim()
  if (requested && !UUID_RE.test(requested)) return { ok: false, status: 400, error: 'invalid_location' }
  if (hubUser.elevated) {
    if (!requested) return { ok: false, status: 400, error: 'location_required' }
    return { ok: true, locationUuid: requested }
  }
  const own = (hubUser.location_id || '').trim()
  if (!own) return { ok: false, status: 403, error: 'no_location' }
  if (requested && requested.toLowerCase() !== own.toLowerCase()) {
    return { ok: false, status: 403, error: 'forbidden_wrong_location' }
  }
  return { ok: true, locationUuid: own }
}

// ── the term ─────────────────────────────────────────────────────────────────
// The browser filter is a plain "contains", so "john.smith@", "o'brien" and
// "(215) 555" must all mean exactly those characters here too. Nothing is
// thrown away except `*`, which PostgREST reads as a wildcard even inside
// quotes and so cannot be matched literally.
export function cleanClientSearchTerm(raw: string | null | undefined): string {
  return (raw || '').replace(/\*/g, ' ').trim().slice(0, CLIENT_SEARCH_MAX_TERM)
}

// % and _ are LIKE wildcards and \ is LIKE's escape: typed by a person they
// are literal characters, so they are escaped rather than obeyed.
const likeLiteral = (term: string) => term.replace(/[\\%_]/g, (m) => `\\${m}`)

// A value inside PostgREST's or=(…) list. `,` `(` `)` `.` are structural
// there; double-quoting the value makes them literal, with \ and " escaped.
function orValue(term: string): string {
  const pattern = `*${likeLiteral(term)}*`
  return `"${pattern.replace(/[\\"]/g, (m) => `\\${m}`)}"`
}

export const CLIENT_SEARCH_FIELDS = ['name', 'email', 'phone'] as const

export function clientSearchOrClause(term: string): string {
  const v = orValue(term)
  return CLIENT_SEARCH_FIELDS.map((f) => `${f}.ilike.${v}`).join(',')
}

// The browser's own test, for the one place the server needs it: telling a
// tag-only hit from one the name/email/phone query already counted.
function matchesDirect(row: { name?: string | null; email?: string | null; phone?: string | null }, term: string): boolean {
  const q = term.toLowerCase()
  return CLIENT_SEARCH_FIELDS.some((f) => String(row[f] || '').toLowerCase().includes(q))
}

// ── the search ───────────────────────────────────────────────────────────────
export type ClientSearchResult = {
  people: any[]
  // Every client at this location matching the term (within olderThan when
  // given) — exact, not an estimate.
  total: number
  capped: boolean
  cap: number
}

type Hit = { id: string; created_at: string | null }

const byNewest = (a: Hit, b: Hit) => {
  const ca = a.created_at || '', cb = b.created_at || ''
  if (ca !== cb) return ca < cb ? 1 : -1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

async function childRows(
  db: any, table: string, col: string, ids: string[],
  order?: { col: string; ascending: boolean }, keyCols: string[] = ['id'], select = '*',
): Promise<any[]> {
  const rows: any[] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    for (let from = 0; ; from += PAGE) {
      let q = db.from(table).select(select).in(col, chunk)
      if (order) q = q.order(order.col, { ascending: order.ascending })
      for (const k of keyCols) q = q.order(k, { ascending: true })
      const { data, error } = await q.range(from, from + PAGE - 1)
      if (error) {
        // A client filed in the wrong band is worse than a failed search:
        // every one of these tables feeds the status derivation.
        throw new Error(`client search: ${table} read failed: ${error.message}`)
      }
      rows.push(...(data || []))
      if ((data || []).length < PAGE) break
    }
  }
  return rows
}

function groupBy(rows: any[], col = 'lead_id'): Record<string, any[]> {
  const out: Record<string, any[]> = {}
  for (const r of rows || []) {
    const k = String(r[col])
    if (!out[k]) out[k] = []
    out[k].push(r)
  }
  return out
}

export async function searchClients(
  db: any,
  opts: { locationUuid: string; term: string; olderThan?: string | null; cap?: number },
): Promise<ClientSearchResult> {
  const cap = opts.cap ?? CLIENT_SEARCH_CAP
  const term = cleanClientSearchTerm(opts.term)
  const locationUuid = opts.locationUuid
  if (!term || !locationUuid) return { people: [], total: 0, capped: false, cap }
  // The page already holds everything newer than this; the cap is spent on
  // the clients it does NOT hold. Inclusive, because thousands of imported
  // clients share one created_at — the screen drops repeats by id.
  const olderThan = opts.olderThan && !isNaN(Date.parse(opts.olderThan)) ? new Date(opts.olderThan).toISOString() : null

  // The fence + the Client List's rule, in one place for every leads read.
  const fenced = (q: any) => {
    let out = applyLeadActiveFilter(q).eq('location_uuid', locationUuid)
    if (olderThan) out = out.lte('created_at', olderThan)
    return out
  }

  // 1 ── name / email / phone. Newest first, the exact count alongside.
  const { data: directRows, count: directCount, error: directErr } = await fenced(
    db.from('leads').select('id, created_at', { count: 'exact' }),
  )
    .or(clientSearchOrClause(term))
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(cap)
  if (directErr) throw new Error(`client search: leads read failed: ${directErr.message}`)
  const direct: Hit[] = (directRows || []).map((r: any) => ({ id: r.id, created_at: r.created_at }))
  const directTotal = typeof directCount === 'number' ? directCount : direct.length

  // 2 ── tag name. Tags this location can use (corporate + its own) whose
  // name contains the term, then the clients carrying one, read back through
  // the same fence. A hit that also matches by name/email/phone was counted
  // in step 1 already and is dropped here, so the total is exact.
  let tagOnly: Hit[] = []
  let tagLinksCapped = false
  const { data: tagRows, error: tagErr } = await db
    .from('lookups')
    .select('id')
    .in('category', TAG_CATEGORIES as unknown as string[])
    .eq('is_active', true)
    .ilike('label', `%${likeLiteral(term)}%`)
    .or(`location_id.is.null,location_id.eq.${locationUuid}`)
    .limit(200)
  if (tagErr) throw new Error(`client search: tag read failed: ${tagErr.message}`)
  const tagIds = (tagRows || []).map((t: any) => t.id)
  if (tagIds.length > 0) {
    const taggedLeadIds = new Set<string>()
    let seen = 0
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('lead_tags')
        .select('lead_id, tag_lookup_id')
        .in('tag_lookup_id', tagIds)
        .order('lead_id', { ascending: true })
        .order('tag_lookup_id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`client search: lead_tags read failed: ${error.message}`)
      for (const l of data || []) taggedLeadIds.add(l.lead_id)
      seen += (data || []).length
      if ((data || []).length < PAGE) break
      if (seen >= TAG_LINK_MAX) { tagLinksCapped = true; break }
    }
    const ids = Array.from(taggedLeadIds)
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const { data, error } = await fenced(
        db.from('leads').select('id, created_at, name, email, phone'),
      ).in('id', ids.slice(i, i + ID_CHUNK))
      if (error) throw new Error(`client search: tagged leads read failed: ${error.message}`)
      for (const r of data || []) {
        if (!matchesDirect(r, term)) tagOnly.push({ id: r.id, created_at: r.created_at })
      }
    }
  }

  const total = directTotal + tagOnly.length
  // `direct` is already the newest `cap` of its own set, so the newest `cap`
  // of the union is in here.
  const picked = [...direct, ...tagOnly].sort(byNewest).slice(0, cap)
  const capped = total > picked.length || tagLinksCapped
  if (picked.length === 0) return { people: [], total, capped, cap }
  const ids = picked.map((h) => h.id)

  // 3 ── the full rows, through the fence AGAIN: the ids are ours, but a
  // client junked or archived between the two reads must not ride in.
  const leadRows: any[] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await fenced(db.from('leads').select('*')).in('id', ids.slice(i, i + ID_CHUNK))
    if (error) throw new Error(`client search: leads hydrate failed: ${error.message}`)
    leadRows.push(...(data || []))
  }
  const leadById = new Map(leadRows.map((r) => [r.id, r]))
  const people = await hydrateClients(db, ids.filter((id) => leadById.has(id)).map((id) => leadById.get(id)))
  return { people, total, capped: capped || people.length < total, cap }
}

// ── browsing: the older clients, A to Z, a page at a time ────────────────────
// Clients at scale, slice 3. On a cut-off location the Client List can walk
// through the clients the page did not load (everything created on or before
// `olderThan`, the oldest client the ordinary load holds), CLIENT_BROWSE_PAGE
// at a time, by name. Same fence and same rule as the search above — one
// location, not junk, not archived — and the same Person shape, so the screen
// bands each row with the code it already uses.
//
// Paged by a cursor (the last row's name + id), not by a row offset: a client
// added, renamed or archived between two presses cannot make the next page
// repeat a row or skip one. The order is the database's own for both the
// ORDER BY and the cursor comparison, so the two cannot disagree.
export const CLIENT_BROWSE_PAGE = 500

export type ClientBrowseCursor = { name: string | null; id: string }
export type ClientBrowseResult = { people: any[]; next: ClientBrowseCursor | null }

// A value inside or=(…) for an exact comparison (no LIKE involved).
const orExact = (v: string) => `"${v.replace(/[\\"]/g, (m) => `\\${m}`)}"`

export async function browseClients(
  db: any,
  opts: { locationUuid: string; olderThan: string; after?: ClientBrowseCursor | null; limit?: number },
): Promise<ClientBrowseResult> {
  const limit = opts.limit ?? CLIENT_BROWSE_PAGE
  if (!opts.locationUuid || !opts.olderThan || isNaN(Date.parse(opts.olderThan))) return { people: [], next: null }
  const olderThan = new Date(opts.olderThan).toISOString()

  let q = applyLeadActiveFilter(db.from('leads').select('*'))
    .eq('location_uuid', opts.locationUuid)
    .lte('created_at', olderThan)
  const after = opts.after
  if (after && after.id) {
    if (after.name === null || after.name === undefined) {
      // Already among the nameless rows, which sort last: only later ids remain.
      q = q.is('name', null).gt('id', after.id)
    } else {
      const n = orExact(after.name)
      q = q.or(`name.gt.${n},and(name.eq.${n},id.gt.${after.id}),name.is.null`)
    }
  }
  // One row past the page tells us whether there is another page.
  const { data, error } = await q
    .order('name', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
    .limit(limit + 1)
  if (error) throw new Error(`client browse: leads read failed: ${error.message}`)
  const rows = (data || []).slice(0, limit)
  const more = (data || []).length > limit
  const last = rows[rows.length - 1]
  const people = await hydrateClients(db, rows)
  return { people, next: more && last ? { name: last.name ?? null, id: last.id } : null }
}

// Lead rows → the page load's Person shape. The caller has ALREADY fenced the
// rows (location, not junk, not archived); this only joins and maps.
export async function hydrateClients(db: any, leadRowsIn: any[]): Promise<any[]> {
  const leadById = new Map(leadRowsIn.map((r) => [r.id, r]))
  const liveIds = leadRowsIn.map((r) => r.id)
  if (liveIds.length === 0) return []

  // 4 ── everything the page load joins to a lead, for these leads only, in
  // the page load's own order (app/_hub-page.tsx fetchChildRows calls). The
  // status band is derived from these — reach-outs from touchpoints, won work
  // from engagements, a Network move from partners — so none may be skipped.
  const [
    notes, touchpoints, contacts, leadTags, assessments, serviceRequests,
    quotes, jobs, invoices, assignees, engagements, partners,
  ] = await Promise.all([
    childRows(db, 'lead_notes', 'lead_id', liveIds, { col: 'created_at', ascending: false }),
    childRows(db, 'touchpoints', 'lead_id', liveIds, { col: 'occurred_at', ascending: false }),
    childRows(db, 'lead_contacts', 'lead_id', liveIds, { col: 'created_at', ascending: true }),
    childRows(db, 'lead_tags', 'lead_id', liveIds, undefined, ['lead_id', 'tag_lookup_id']),
    childRows(db, 'assessments', 'lead_id', liveIds, { col: 'scheduled_at', ascending: false }),
    childRows(db, 'service_requests', 'lead_id', liveIds, { col: 'created_at', ascending: false }),
    childRows(db, 'quotes', 'lead_id', liveIds, { col: 'sent_at', ascending: false }),
    childRows(db, 'jobs', 'lead_id', liveIds, { col: 'scheduled_start', ascending: false }),
    childRows(db, 'invoices', 'lead_id', liveIds, { col: 'issued_at', ascending: false }),
    childRows(db, 'lead_assignees', 'lead_id', liveIds, { col: 'created_at', ascending: true }, ['lead_id', 'hub_user_id']),
    childRows(db, 'engagements', 'client_id', liveIds, undefined, ['id'], 'id, client_id, stage, total_paid, total_invoiced, closed_at, created_at'),
    // partners.customer_lead_id is text; deleted partners never count.
    (async () => {
      const rows: any[] = []
      for (let i = 0; i < liveIds.length; i += ID_CHUNK) {
        const { data, error } = await db
          .from('partners').select('customer_lead_id, is_customer')
          .is('deleted_at', null).in('customer_lead_id', liveIds.slice(i, i + ID_CHUNK))
        if (error) throw new Error(`client search: partners read failed: ${error.message}`)
        rows.push(...(data || []))
      }
      return rows
    })(),
  ])

  const tagLookupIds = Array.from(new Set(leadTags.map((lt: any) => lt.tag_lookup_id)))
  const tag_lookups: Record<string, any> = {}
  for (let i = 0; i < tagLookupIds.length; i += ID_CHUNK) {
    const { data, error } = await db.from('lookups').select('*').in('id', tagLookupIds.slice(i, i + ID_CHUNK))
    if (error) throw new Error(`client search: tag lookups read failed: ${error.message}`)
    for (const row of data || []) tag_lookups[row.id] = row
  }

  const notesBy = groupBy(notes), touchBy = groupBy(touchpoints), contactsBy = groupBy(contacts)
  const tagsBy = groupBy(leadTags), assessBy = groupBy(assessments), srBy = groupBy(serviceRequests)
  const quotesBy = groupBy(quotes), jobsBy = groupBy(liveJobs(jobs)), invBy = groupBy(liveInvoices(invoices))
  const assigneesBy = groupBy(assignees), engBy = groupBy(engagements, 'client_id')
  const networkMoved = new Set<string>()
  for (const p of partners) if (p.is_customer !== true && p.customer_lead_id) networkMoved.add(String(p.customer_lead_id))

  return liveIds.map((id) => {
    const row = leadById.get(id)
    return mapLeadToPerson(row, {
      lead_notes:       notesBy[id]     || [],
      touchpoints:      touchBy[id]     || [],
      lead_contacts:    contactsBy[id]  || [],
      lead_tags:        tagsBy[id]      || [],
      assessments:      assessBy[id]    || [],
      service_requests: srBy[id]        || [],
      quotes:           quotesBy[id]    || [],
      jobs:             jobsBy[id]      || [],
      invoices:         invBy[id]       || [],
      lead_assignees:   assigneesBy[id] || [],
      tag_lookups,
      // The same roll-up the single-lead refetch ships (lib/engagement-rollup)
      // — engagement_count, won_summary, last_closed_at.
      ...rollUpEngagements(engBy[id] || []),
      network_moved: networkMoved.has(id),
    } as any)
  })
}
