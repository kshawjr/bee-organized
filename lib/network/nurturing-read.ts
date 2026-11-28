// lib/network/nurturing-read.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 7 — the READS behind the Nurturing tab.
// SELECTs only. This file never inserts, updates, upserts, deletes or calls
// a database function; lib/network/nurturing-read-only.test.ts pins that by
// fingerprint and with a fake database that records every call.
//
// THE LOCATION TRAP. leads.location_id holds a text slug
// ('loc_phillysuburbs'); partners.location_id and the screen's location
// picker hold the locations.id uuid. They do not join the same way. So:
//   · leads are read by leads.location_uuid, which is filled on every lead
//     and agrees with locations.slug on every lead (checked 2026-11-19:
//     0 empty, 0 disagreeing);
//   · assessments, quotes and jobs carry only the slug, so they are read by
//     locations.slug, looked up from the uuid the screen sends;
//   · each activity row is then matched to its person by lead_id, never by
//     location. (Every activity row's lead sits at the same location as the
//     row: 0 exceptions on 2026-11-19. The proof that code and SQL agree on
//     all 52 locations would catch it if that ever stopped being true,
//     because the SQL joins by lead_id alone.)
//
// SIZE. Philadelphia Suburbs holds 18,939 people, 18,826 of them Nurturing.
// The people are read in pages of 1,000, several at a time, and the folded
// list is kept for a minute per location so turning a page does not read
// them again. Only one page of rows is ever sent to the browser.
// ─────────────────────────────────────────────────────────────

import { saidNoToMarketing } from './nurturing-actions'
import { TAG_CATEGORY, tagShowsOn } from '../tags'
import {
  NURTURING_QUIET_DAYS, NURTURING_EXCLUDED_LOCATIONS, foldActivity, needsContactInfo, nurtureName, nurturingCutoffs, nurturingVerdict, addressLine,
  quoteAt, assessmentAt, jobCounts,
  type NurtureRow,
} from './nurturing'

const PAGE = 1000
const PARALLEL = 6
const CACHE_MS = 60_000

export const NURTURE_LEAD_COLS = 'id, location_id, name, first_name, last_name, email, phone, city, zip, created_at, archived_at, is_junk, marketing_opt_out, marketing_unsubscribed_at, paid_amount, invoice_paid_at, nurture_choice'

export type NurtureLocation = { id: string; slug: string; name: string | null }
export type NurtureList = { excluded?: boolean; rows: NurtureRow[]; counts: { nurturing: number; needsContactInfo: number; hadQuoteOrAssessment: number }; readMs: number; peopleRead: number }

type Db = { from: (table: string) => any }

async function pageAll(make: () => any, label: string): Promise<any[]> {
  const out: any[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make().range(from, from + PAGE - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    out.push(...(data || []))
    if ((data || []).length < PAGE) return out
  }
}

export async function nurtureLocation(db: Db, uuid: string): Promise<NurtureLocation | null> {
  const { data, error } = await db.from('locations').select('id, slug, name').eq('id', uuid).maybeSingle()
  if (error) throw new Error(`locations: ${error.message}`)
  if (!data || !data.slug) return null
  return { id: data.id, slug: data.slug, name: data.name ?? null }
}

/** The location's people who could be Nurturing, pre-filtered by the rule's own cut-offs. */
async function readCandidates(db: Db, loc: NurtureLocation, createdBefore: string) {
  const base = () => db.from('leads')
    .select(NURTURE_LEAD_COLS)
    .eq('location_uuid', loc.id)
    .is('archived_at', null)
    .not('is_junk', 'is', true)
    .lt('created_at', createdBefore)
    .order('id', { ascending: true })
  const head = await db.from('leads').select('id', { count: 'exact', head: true })
    .eq('location_uuid', loc.id).is('archived_at', null).not('is_junk', 'is', true).lt('created_at', createdBefore)
  if (head.error) throw new Error(`leads count: ${head.error.message}`)
  const total = head.count ?? 0
  const starts: number[] = []
  for (let s = 0; s < total; s += PAGE) starts.push(s)
  const pages: any[][] = new Array(starts.length)
  for (let i = 0; i < starts.length; i += PARALLEL) {
    await Promise.all(starts.slice(i, i + PARALLEL).map(async (s, k) => {
      const { data, error } = await base().range(s, s + PAGE - 1)
      if (error) throw new Error(`leads: ${error.message}`)
      pages[i + k] = data || []
    }))
  }
  // A person added between the count and the pages lands past the end: read on until a short page.
  let rows = pages.flat()
  for (let from = starts.length * PAGE; ; from += PAGE) {
    const { data, error } = await base().range(from, from + PAGE - 1)
    if (error) throw new Error(`leads: ${error.message}`)
    rows = rows.concat(data || [])
    if ((data || []).length < PAGE) break
  }
  // People an owner put in Nurturing (nurture_choice 'in') skip the 30-day
  // wait, so they are read too, whatever their age (few: one row per choice;
  // anyone read twice is kept once, below).
  const chosen = await pageAll(() => db.from('leads').select(NURTURE_LEAD_COLS)
    .eq('location_uuid', loc.id).is('archived_at', null).not('is_junk', 'is', true)
    .eq('nurture_choice', 'in').order('id', { ascending: true }), 'chosen leads')
  rows = rows.concat(chosen)
  const seen = new Set<string>()
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
}

async function readActivity(db: Db, slug: string, uuid: string) {
  const [assessments, quotes, jobs, openCards, wonCards] = await Promise.all([
    pageAll(() => db.from('assessments').select('id, lead_id, completed_at, scheduled_at, created_at').eq('location_id', slug).order('id'), 'assessments'),
    pageAll(() => db.from('quotes').select('id, lead_id, status, sent_at, created_at').eq('location_id', slug).order('id'), 'quotes'),
    pageAll(() => db.from('jobs').select('id, lead_id, status').eq('location_id', slug).order('id'), 'jobs'),
    // Open cards (2,285 across every location on 2026-11-20) and won cards.
    // Engagements carry the location uuid; every open card sits at its
    // person's location.
    pageAll(() => db.from('engagements').select('id, client_id, closed_at, stage').eq('location_uuid', uuid).is('closed_at', null).order('id'), 'engagements'),
    pageAll(() => db.from('engagements').select('id, client_id, closed_at, stage').eq('location_uuid', uuid).eq('stage', 'Closed Won').order('id'), 'won engagements'),
  ])
  return { assessments, quotes, jobs, cards: [...openCards, ...wonCards] }
}

const cache = new Map<string, { at: number; list: NurtureList }>()
export function clearNurtureCache() { cache.clear() }

/** Everyone Nurturing at one location, as list rows, plus the counts. */
export async function loadNurturingList(db: Db, loc: NurtureLocation, opts: { now?: Date; quietDays?: number; useCache?: boolean } = {}): Promise<NurtureList> {
  const now = opts.now ?? new Date()
  const quietDays = opts.quietDays ?? NURTURING_QUIET_DAYS
  const key = `${loc.id}|${quietDays}`
  const hit = opts.useCache === false ? null : cache.get(key)
  if (hit && now.getTime() - hit.at < CACHE_MS) return hit.list

  const started = Date.now()
  // The transfer queue: nobody is Nurturing there, so nothing is read.
  if (NURTURING_EXCLUDED_LOCATIONS.includes(loc.slug)) {
    return { excluded: true, rows: [], counts: { nurturing: 0, needsContactInfo: 0, hadQuoteOrAssessment: 0 }, readMs: 0, peopleRead: 0 }
  }
  const { createdBefore } = nurturingCutoffs(now, quietDays)
  const [people, act] = await Promise.all([readCandidates(db, loc, createdBefore), readActivity(db, loc.slug, loc.id)])
  const folded = foldActivity(act.assessments, act.quotes, act.jobs, act.cards)
  const rows: NurtureRow[] = []
  let needs = 0
  let had = 0
  for (const p of people) {
    const v = nurturingVerdict(p, folded, now, quietDays)
    if (!v.nurturing) continue
    if (v.needsContactInfo) needs++
    if (v.lastActivity) had++
    rows.push({
      id: p.id, name: nurtureName(p), email: p.email || null, phone: p.phone || null,
      city: p.city || null, zip: p.zip || null, createdAt: p.created_at,
      needsContactInfo: v.needsContactInfo, lastActivity: v.lastActivity,
      noMarketing: saidNoToMarketing(p),
    })
  }
  const list: NurtureList = { rows, counts: { nurturing: rows.length, needsContactInfo: needs, hadQuoteOrAssessment: had }, readMs: Date.now() - started, peopleRead: people.length }
  if (opts.useCache !== false) cache.set(key, { at: now.getTime(), list })
  return list
}

// ── One person, opened ────────────────────────────────────────

export const NURTURE_PERSON_COLS =
  'id, location_id, location_uuid, name, first_name, last_name, company, email, phone, address, street2, city, state, zip, ' +
  'source, project_type, request_details, notes, created_at, archived_at, is_junk, marketing_opt_out, marketing_unsubscribed_at, paid_amount, invoice_paid_at, ' +
  'preferred_contact, referred_by_kind, nurture_choice'

/**
 * The tags a Nurturing person can be given at this location: THE one tag list,
 * the groups that show on Clients (Nurture shares the client groups, Kevin's
 * tag ruling 2026-11-15), active, corporate or this location's own.
 */
export async function loadNurtureTags(db: Db, locationUuid: string) {
  const { data, error } = await db.from('lookups').select('id, label, icon, category, location_id, is_active, attrs, sort_order').eq('category', TAG_CATEGORY)
  if (error) throw new Error(`lookups: ${error.message}`)
  return (data || [])
    .filter((t: any) => t.is_active !== false && (!t.location_id || t.location_id === locationUuid) && tagShowsOn(t, 'clients'))
    .sort((a: any, b: any) => String(a.label).localeCompare(String(b.label)))
    .map((t: any) => ({ id: t.id as string, label: t.label as string, icon: (t.icon ?? null) as string | null, own: !!t.location_id }))
}

/** Everything the person view shows. SELECTs only. */
export async function loadNurturePerson(db: Db, id: string, opts: { now?: Date; quietDays?: number; callerId?: string | null; mayRead?: (locationUuid: string | null) => boolean } = {}) {
  const now = opts.now ?? new Date()
  const quietDays = opts.quietDays ?? NURTURING_QUIET_DAYS
  const one = async (table: string, cols: string, order = 'created_at') => {
    const { data, error } = await db.from(table).select(cols).eq('lead_id', id).order(order, { ascending: false }).limit(50)
    if (error) throw new Error(`${table}: ${error.message}`)
    return data || []
  }
  const { data: lead, error } = await db.from('leads').select(NURTURE_PERSON_COLS).eq('id', id).maybeSingle()
  if (error) throw new Error(`leads: ${error.message}`)
  if (!lead) return null
  // The route's location rule, asked about the person's OWN location before
  // anything else is read: someone else's person is simply not found.
  if (opts.mayRead && !opts.mayRead((lead as any).location_uuid ?? null)) return null
  const [assessments, quotes, jobs, requests, engagements, tagLinks, touchpoints, loc, followUps] = await Promise.all([
    one('assessments', 'id, status, scheduled_at, completed_at, created_at, assessment_type'),
    one('quotes', 'id, status, total, sent_at, approved_at, created_at'),
    one('jobs', 'id, status, title, total, created_at'),
    one('service_requests', 'id, status, stage, requested_at, created_at, source'),
    (async () => {
      const { data, error: e } = await db.from('engagements').select('id, client_id, title, stage, closed_reason, closed_at, created_at').eq('client_id', id).order('created_at', { ascending: false }).limit(50)
      if (e) throw new Error(`engagements: ${e.message}`)
      return data || []
    })(),
    (async () => {
      const { data, error: e } = await db.from('lead_tags').select('tag_lookup_id').eq('lead_id', id)
      if (e) throw new Error(`lead_tags: ${e.message}`)
      return data || []
    })(),
    one('touchpoints', 'id, kind, method, label, status, occurred_at, created_at', 'occurred_at'),
    (async () => {
      const { data, error: e } = await db.from('locations').select('id, name').eq('id', lead.location_uuid).maybeSingle()
      if (e) throw new Error(`locations: ${e.message}`)
      return data
    })(),
    // The viewer's OWN open follow-ups on this person: reminders are personal, as everywhere.
    (async () => {
      if (!opts.callerId) return []
      const { data, error: e } = await db.from('reminders').select('id, due_on, note').eq('lead_id', id).eq('user_id', opts.callerId).is('done_at', null).order('due_on', { ascending: true })
      if (e) throw new Error(`reminders: ${e.message}`)
      return data || []
    })(),
  ])
  const tagIds = tagLinks.map((t: any) => t.tag_lookup_id).filter(Boolean)
  let tags: { id: string; label: string; icon: string | null }[] = []
  if (tagIds.length) {
    const { data, error: e } = await db.from('lookups').select('id, label, icon').in('id', tagIds)
    if (e) throw new Error(`lookups: ${e.message}`)
    tags = (data || []).map((t: any) => ({ id: t.id, label: t.label, icon: t.icon ?? null }))
  }
  const folded = foldActivity(assessments.map((a: any) => ({ ...a, lead_id: id })), quotes.map((q: any) => ({ ...q, lead_id: id })), jobs.map((j: any) => ({ ...j, lead_id: id })), engagements.map((e: any) => ({ client_id: id, closed_at: e.closed_at, stage: e.stage })))
  const verdict = nurturingVerdict(lead, folded, now, quietDays)
  return {
    person: {
      id: lead.id, name: nurtureName(lead), company: lead.company || null, email: lead.email || null, phone: lead.phone || null,
      cityLine: [lead.city, [lead.state, lead.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null,
      // One line, never the town or zip twice (some imports put the whole address in the street field).
      address: addressLine([lead.address, lead.street2].filter(Boolean).join(', ') || null,
        [lead.city, [lead.state, lead.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null, lead.zip),
      source: lead.source || null, projectType: lead.project_type || null, requestDetails: lead.request_details || null,
      notes: lead.notes || null, createdAt: lead.created_at, locationName: loc?.name ?? null, locationId: lead.location_uuid,
      preferredContact: lead.preferred_contact || null,
      marketing: lead.marketing_unsubscribed_at ? { state: 'unsubscribed', at: lead.marketing_unsubscribed_at }
        : lead.marketing_opt_out ? { state: 'opted_out', at: null } : { state: 'ok', at: null },
      needsContactInfo: needsContactInfo(lead),
      noMarketing: saidNoToMarketing(lead),
    },
    followUps: followUps.map((r: any) => ({ id: r.id, dueOn: r.due_on, note: r.note })),
    verdict,
    quietDays,
    assessments: assessments.map((a: any) => ({ id: a.id, status: a.status, type: a.assessment_type || null, at: assessmentAt(a) })),
    quotes: quotes.map((q: any) => ({ id: q.id, status: q.status, total: q.total ?? null, at: quoteAt(q) ?? q.created_at, counts: q.status !== 'draft' })),
    jobs: jobs.map((j: any) => ({ id: j.id, status: j.status, title: j.title || null, total: j.total ?? null, at: j.created_at, counts: jobCounts(j) })),
    requests: requests.map((r: any) => ({ id: r.id, status: r.status || r.stage || null, at: r.requested_at || r.created_at })),
    engagements: engagements.map((e: any) => ({ id: e.id, title: e.title || null, stage: e.stage, closedReason: e.closed_reason || null, closedAt: e.closed_at || null })),
    tags,
    touchpoints: touchpoints.slice(0, 8).map((t: any) => ({ id: t.id, label: t.label || t.kind || null, method: t.method || null, status: t.status || null, at: t.occurred_at || t.created_at })),
  }
}
