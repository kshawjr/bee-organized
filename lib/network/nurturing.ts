// lib/network/nurturing.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 7 — WHO IS NURTURING. Kevin's rule,
// settled 2026-11-19. This file is the rule, in one place. Every screen,
// route and proof reads it from here; nothing else decides.
//
// A person (a `leads` row) is Nurturing when ALL of these are true:
//
//   1. They never had a job. A job whose status is `deleted` does not count.
//   2. Any assessment or quote they had is more than NURTURING_QUIET_DAYS
//      old. A quote whose status is `draft` does not count at all. A bare
//      request with no assessment does not count (owners used requests as a
//      list before Bee Hub). Because rule 1 says "never a job", "with no job
//      after it" is already true.
//   3. They were created more than NURTURING_MIN_AGE_DAYS ago.
//   4. They are not archived and not junk.
//   5. They have no OPEN card: no engagement with closed_at empty (Kevin,
//      2026-11-20). A live card means an owner is working them, not keeping
//      them warm; they come back when the card closes. A card closed as LOST
//      does not take them out: Lost usually means "stopped replying" (the
//      auto-close cron's "No response"), which is who a nurture list is for.
//   7. They have NEVER PAID and have NO WON CARD (Kevin, 2026-11-20: six
//      people who paid $17,641 between them had no job row, so rule 1 let
//      them through). Three checks, any one is enough to rule them out:
//        · leads.paid_amount greater than 0
//        · leads.invoice_paid_at set
//        · an engagement with stage 'Closed Won'
//   6. They are not at Test Location (Kevin's sandbox) or in the transfer
//      queue (loc_other: unrouted people belong to no owner yet). The same
//      two slugs the auto-close cron never touches.
//
// Someone with no email and no phone STAYS IN. They are flagged "Needs
// contact info" so an owner can find and fix them; they are never hidden.
//
// THE DATES, for "how old is an assessment or quote" (the same dates the
// brief's production count used; a different choice gives a different
// number):
//   · assessment: the latest of completed_at, scheduled_at, created_at
//   · quote:      the latest of sent_at, created_at
//
// THE ONE SETTING: NURTURING_QUIET_DAYS. Kevin may lower it. Changing it
// here changes the list, the counts, the person view's "why" line and the
// SQL below together, because they all read it.
//
// This is a READ rule. Nothing here writes, and nothing here reads
// leads.stage or leads.client_status (both are stale import snapshots, see
// the nurturing-is-derived note): Nurturing is worked out fresh every time.
// ─────────────────────────────────────────────────────────────

/** THE setting. Days since the last assessment or quote. */
export const NURTURING_QUIET_DAYS = 90
/** Days since the person was created. */
export const NURTURING_MIN_AGE_DAYS = 30
/** Locations nobody is Nurturing at, by slug (leads.location_id). */
export const NURTURING_EXCLUDED_LOCATIONS: readonly string[] = ['loc_test', 'loc_other']

const DAY_MS = 24 * 60 * 60 * 1000

export type NurtureLead = {
  id: string
  created_at: string | null
  archived_at?: string | null
  is_junk?: boolean | null
  email?: string | null
  phone?: string | null
  /** the slug; when given, an excluded location rules them out */
  location_id?: string | null
  paid_amount?: number | string | null
  invoice_paid_at?: string | null
}
export type NurtureAssessment = { lead_id: string | null; completed_at?: string | null; scheduled_at?: string | null; created_at?: string | null }
export type NurtureQuote = { lead_id: string | null; status?: string | null; sent_at?: string | null; created_at?: string | null }
export type NurtureJob = { lead_id: string | null; status?: string | null }
/** An engagement (a card). Open = closed_at is empty. Won = stage 'Closed Won'. */
export type NurtureCard = { client_id: string | null; closed_at?: string | null; stage?: string | null }

/** Rule 7: has this person ever paid? (the card check is separate: a won card) */
export function hasPaid(lead: Pick<NurtureLead, 'paid_amount' | 'invoice_paid_at'>): boolean {
  return (Number(lead.paid_amount) || 0) > 0 || !!lead.invoice_paid_at
}

export type LastActivity = { at: string; kind: 'assessment' | 'quote' } | null

const t = (iso: string | null | undefined) => {
  if (!iso) return null
  const n = new Date(iso).getTime()
  return Number.isFinite(n) ? n : null
}
const latest = (...isos: (string | null | undefined)[]) => {
  let best: number | null = null
  let bestIso: string | null = null
  for (const iso of isos) {
    const n = t(iso)
    if (n !== null && (best === null || n > best)) { best = n; bestIso = iso as string }
  }
  return bestIso
}

/** The date an assessment counts from. */
export function assessmentAt(a: NurtureAssessment): string | null {
  return latest(a.completed_at, a.scheduled_at, a.created_at)
}
/** The date a quote counts from; a draft never counts. */
export function quoteAt(q: NurtureQuote): string | null {
  if (q.status === 'draft') return null
  return latest(q.sent_at, q.created_at)
}
/** A job counts unless it was deleted. */
export function jobCounts(j: NurtureJob): boolean {
  return j.status !== 'deleted'
}

export function needsContactInfo(lead: Pick<NurtureLead, 'email' | 'phone'>): boolean {
  return !String(lead.email ?? '').trim() && !String(lead.phone ?? '').trim()
}

/** The cut-offs for one moment. Every caller uses this, so they agree. */
export function nurturingCutoffs(now: Date | number, quietDays = NURTURING_QUIET_DAYS) {
  const ms = typeof now === 'number' ? now : now.getTime()
  return {
    createdBefore: new Date(ms - NURTURING_MIN_AGE_DAYS * DAY_MS).toISOString(),
    quietBefore: new Date(ms - quietDays * DAY_MS).toISOString(),
  }
}

/** A card is open until it has a closed_at. Closed Won and Closed Lost both set it. */
export function cardIsOpen(c: NurtureCard): boolean {
  return !c.closed_at
}

/** Everyone's activity, folded once: id → had a job, has an open card, and their last assessment/quote. */
export function foldActivity(assessments: NurtureAssessment[], quotes: NurtureQuote[], jobs: NurtureJob[], cards: NurtureCard[] = []) {
  const hadJob = new Set<string>()
  const openCard = new Set<string>()
  const wonCard = new Set<string>()
  for (const c of cards) {
    if (!c.client_id) continue
    if (cardIsOpen(c)) openCard.add(c.client_id)
    if (c.stage === 'Closed Won') wonCard.add(c.client_id)
  }
  const last = new Map<string, { at: string; ms: number; kind: 'assessment' | 'quote' }>()
  const put = (id: string | null, at: string | null, kind: 'assessment' | 'quote') => {
    if (!id || !at) return
    const ms = t(at)!
    const now = last.get(id)
    if (!now || ms > now.ms) last.set(id, { at, ms, kind })
  }
  for (const j of jobs) if (j.lead_id && jobCounts(j)) hadJob.add(j.lead_id)
  for (const a of assessments) put(a.lead_id, assessmentAt(a), 'assessment')
  for (const q of quotes) put(q.lead_id, quoteAt(q), 'quote')
  return { hadJob, openCard, wonCard, last }
}
export type FoldedActivity = ReturnType<typeof foldActivity>

export type NurtureVerdict = {
  nurturing: boolean
  /** Why not, in plain words, when nurturing is false. */
  why: 'excluded_location' | 'archived' | 'junk' | 'too_new' | 'had_job' | 'paid_or_won' | 'open_card' | 'recent_activity' | null
  needsContactInfo: boolean
  lastActivity: LastActivity
}

/** THE RULE, for one person. */
export function nurturingVerdict(lead: NurtureLead, activity: FoldedActivity, now: Date | number, quietDays = NURTURING_QUIET_DAYS): NurtureVerdict {
  const { createdBefore, quietBefore } = nurturingCutoffs(now, quietDays)
  const l = activity.last.get(lead.id)
  const lastActivity: LastActivity = l ? { at: l.at, kind: l.kind } : null
  const base = { needsContactInfo: needsContactInfo(lead), lastActivity }
  if (lead.location_id && NURTURING_EXCLUDED_LOCATIONS.includes(lead.location_id)) return { nurturing: false, why: 'excluded_location', ...base }
  if (lead.archived_at) return { nurturing: false, why: 'archived', ...base }
  if (lead.is_junk === true) return { nurturing: false, why: 'junk', ...base }
  const created = t(lead.created_at)
  if (created === null || created >= t(createdBefore)!) return { nurturing: false, why: 'too_new', ...base }
  if (activity.hadJob.has(lead.id)) return { nurturing: false, why: 'had_job', ...base }
  if (hasPaid(lead) || activity.wonCard.has(lead.id)) return { nurturing: false, why: 'paid_or_won', ...base }
  if (activity.openCard.has(lead.id)) return { nurturing: false, why: 'open_card', ...base }
  if (l && l.ms >= t(quietBefore)!) return { nurturing: false, why: 'recent_activity', ...base }
  return { nurturing: true, why: null, ...base }
}

/**
 * THE SAME RULE IN SQL, built from the same two numbers. Used by the proof
 * that code and SQL agree on every location, and as the record of what the
 * count means. `:now` is the moment; it returns one row per Nurturing person.
 * Read-only: a SELECT, nothing else.
 */
export function nurturingSql(quietDays = NURTURING_QUIET_DAYS, nowSql = 'now()') {
  return `with j as (select distinct lead_id from jobs where status is distinct from 'deleted'),
a as (select lead_id, max(greatest(completed_at, scheduled_at, created_at)) t from assessments group by 1),
q as (select lead_id, max(greatest(sent_at, created_at)) t from quotes where status is distinct from 'draft' group by 1)
select l.id, l.location_id, l.location_uuid,
  (coalesce(btrim(l.email),'') = '' and coalesce(btrim(l.phone),'') = '') as needs_contact_info
from leads l
left join a on a.lead_id = l.id
left join q on q.lead_id = l.id
where l.archived_at is null
  and l.is_junk is not true
  and l.location_id not in (${NURTURING_EXCLUDED_LOCATIONS.map((x) => `'${x}'`).join(', ')})
  and not exists (select 1 from engagements e where e.client_id = l.id and e.closed_at is null)
  and coalesce(l.paid_amount, 0) <= 0
  and l.invoice_paid_at is null
  and not exists (select 1 from engagements e where e.client_id = l.id and e.stage = 'Closed Won')
  and l.created_at < ${nowSql} - interval '${NURTURING_MIN_AGE_DAYS} days'
  and not exists (select 1 from j where j.lead_id = l.id)
  and coalesce(greatest(a.t, q.t), '-infinity') < ${nowSql} - interval '${quietDays} days'`
}

// ── The list: search, filter, sort, page. Pure. ──────────────

export type NurtureRow = {
  id: string
  name: string
  email: string | null
  phone: string | null
  city: string | null
  zip: string | null
  createdAt: string
  needsContactInfo: boolean
  lastActivity: LastActivity
  /** said no to marketing (opted out or unsubscribed): left out of every action (slice 8) */
  noMarketing: boolean
}

export const NURTURE_SORTS = [
  { value: 'az', label: 'A–Z' },
  { value: 'newest', label: 'Recently added' },
  { value: 'oldest', label: 'Added longest ago' },
  { value: 'quoted', label: 'Most recent quote or assessment' },
] as const
export type NurtureSort = (typeof NURTURE_SORTS)[number]['value']
export const isNurtureSort = (s: unknown): s is NurtureSort => NURTURE_SORTS.some((o) => o.value === s)

const digits = (s: string) => s.replace(/\D/g, '')

export function searchNurture(rows: NurtureRow[], q: string): NurtureRow[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return rows
  return rows.filter((r) => {
    const hay = [r.name, r.email, r.phone, r.city, r.zip].filter(Boolean).join(' ').toLowerCase()
    const phone = digits(r.phone || '')
    return words.every((w) => hay.includes(w) || (/^[\d()+.-]+$/.test(w) && digits(w).length >= 3 && phone.includes(digits(w))))
  })
}

export function sortNurture(rows: NurtureRow[], sort: NurtureSort): NurtureRow[] {
  const byName = (a: NurtureRow, b: NurtureRow) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id)
  const at = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : 0)
  const out = rows.slice()
  if (sort === 'newest') out.sort((a, b) => at(b.createdAt) - at(a.createdAt) || byName(a, b))
  else if (sort === 'oldest') out.sort((a, b) => at(a.createdAt) - at(b.createdAt) || byName(a, b))
  else if (sort === 'quoted') out.sort((a, b) => at(b.lastActivity?.at) - at(a.lastActivity?.at) || byName(a, b))
  else out.sort(byName)
  return out
}

/** Display name: never blank, so a row is always something to tap. */
// Some imported names carry stray punctuation at the ends (", Bernadette
// Gruszka", ". Openaker": seen on the first page of Philadelphia Suburbs),
// which sorted them to the top of A–Z and made initials like ",B". The
// list shows the name without it. Display only: nothing is written back.
const tidy = (x: unknown) => String(x ?? '').replace(/^[\s,.;:\-–—_'"`]+|[\s,.;:\-–—_'"`]+$/g, '').replace(/\s+/g, ' ')
export function nurtureName(l: { name?: string | null; first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null }): string {
  const n = tidy(l.name) || [l.first_name, l.last_name].map(tidy).filter(Boolean).join(' ')
  return n || String(l.email ?? '').trim() || String(l.phone ?? '').trim() || 'No name'
}

/** "12 Elm St" + "Media, PA 19063", without saying the town or zip twice when the street line already holds them. */
export function addressLine(street: string | null, cityLine: string | null, zip: string | null = null): string | null {
  const s = String(street ?? '').trim()
  const c = String(cityLine ?? '').trim()
  if (!s) return c || null
  if (!c) return s
  const low = s.toLowerCase()
  const z = String(zip ?? '').trim()
  if ((z && low.includes(z.toLowerCase())) || low.includes(c.toLowerCase())) return s
  return `${s}, ${c}`
}
