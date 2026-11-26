// lib/mailchimp-review.ts
//
// MAILCHIMP SLICE 5 (FL-75, 2026-11-24): "Who goes to Mailchimp" — the rules
// behind the first-connect review screen. Pure: no database, no Mailchimp, no
// network. The loader (lib/mailchimp-review-load.ts) feeds it; the route and
// the screen both use what it returns, so the number an owner sees and the
// number saved are worked out in one place.
//
// WHY IT EXISTS (Kevin, 2026-11-24): in the old system every lead went into
// Jobber and Jobber fed Mailchimp. Now leads land in Bee Hub first, and
// anyone who never books never reaches Jobber, so never reaches Mailchimp.
// This screen is the owner's first look at that gap. Most people are already
// in Mailchimp (Chattanooga: 571 of 714 addresses), so the screen says so.
//
// KEVIN'S RULING (2026-11-24)
//   • Everyone starts TICKED — including people with no history in Bee Hub
//     ("never had contact" usually means their history stayed in Jobber).
//   • Archived people start UNTICKED, are shown with the day they were
//     archived, and are never hidden behind a filter.
//   • Anyone on the no-marketing list, marked "No marketing emails",
//     unsubscribed or in the Recycle Bin can NEVER be ticked: they are not in
//     the list at all, only counted. A stored tick cannot bring them back —
//     isIncluded() only ever sees people who could be offered, and the
//     database refuses the tick too (migrations/mailchimp_review_choices.sql).
//   • One big number first; groups with counts; the full list only for
//     exceptions.
//
// PHONE MATCHES are suggestions. A Mailchimp member with a different email
// but the same phone as a Bee Hub person is shown as "Is this the same
// person?", one at a time. Until the owner says yes, nothing changes. A yes
// only moves that Bee Hub person from "new to Mailchimp" to "already in your
// Mailchimp" on this screen — no record is joined, merged or edited.
//
// NOTHING SENDS from here. The choices are kept for the sending step (slice 6).

import { emailKey, mailchimpEligibility, buildMatchIndex, matchContact, type MailchimpIneligibleReason } from './mailchimp-rules'

// A day with at least this many people who have no history in Bee Hub and
// were all added that day is shown as its own group ("Added on 15 Nov 2024").
// Those are the bulk loads. Smaller days fold into one group.
export const BULK_DAY_MIN = 50

export type ReviewLead = {
  id: string
  email: string | null
  phone?: string | null
  first_name?: string | null
  last_name?: string | null
  name?: string | null
  created_at?: string | null
  is_junk?: boolean | null
  marketing_opt_out?: boolean | null
  marketing_unsubscribed_at?: string | null
  archived_at?: string | null
}

export type ReviewMember = { id: string; email: string; emailKey: string | null; status: string; phone: string | null }

export type StoredChoice = { scope: 'group' | 'person' | 'phone'; key: string; choice: 'in' | 'out' | 'same' | 'different' }

// One person on the review list = one email address that is new to Mailchimp
// and could be offered. Short field names: Philadelphia's list is ~19,000 rows.
export type ReviewPerson = {
  k: string            // email key (lower-case, trimmed) — what choices are saved against
  e: string            // the address as typed on the record
  n: string            // name, or '' when the record has none
  g: string            // group key
  a?: string           // archived_at, for archived people only
  c?: 'in' | 'out'     // the owner's own tick for this person, if they made one
}

export type ReviewGroup = {
  key: string
  label: string
  detail: string
  count: number
  defaultIn: boolean
  choice: 'in' | 'out' | null   // the owner's choice for the whole group, if made
}

export type PhoneSuggestion = {
  id: string                 // '<member id>|<bee hub address>' — the saved key
  mailchimpEmail: string
  mailchimpStatus: string
  phone: string | null
  beeHubName: string
  beeHubEmail: string
  answer: 'same' | 'different' | null
}

export type ReviewModel = {
  mailchimpKnown: boolean
  alreadyInMailchimp: number         // addresses on both sides (by email), plus phone matches confirmed "same"
  alreadyByPhone: number             // of those, the ones the owner matched by phone
  alreadyByStatus: Record<string, number>
  notOffered: { total: number; byReason: Partial<Record<MailchimpIneligibleReason, number>> }
  groups: ReviewGroup[]
  people: ReviewPerson[]
  phone: PhoneSuggestion[]
  adding: number                     // THE big number
}

const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] || 0) + 1 }

export function displayName(l: ReviewLead): string {
  const fl = [l.first_name, l.last_name].map((s) => (s || '').trim()).filter(Boolean).join(' ')
  return fl || (l.name || '').trim()
}

// The calendar day (YYYY-MM-DD) of a timestamp in the location's time zone.
export function dayIn(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  } catch {
    return d.toISOString().slice(0, 10)
  }
}

export function prettyDay(day: string): string {
  const d = new Date(day + 'T12:00:00Z')
  if (Number.isNaN(d.getTime())) return day
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
}

export function groupWords(key: string, count: number): { label: string; detail: string } {
  const people = count === 1 ? 'person' : 'people'
  if (key === 'archived') return { label: 'Archived', detail: `Start unticked. Each one shows the day they were archived. Tick any you want in Mailchimp.` }
  if (key === 'worked') return { label: 'Worked with you', detail: `Had a job, quote, request, card or note with you in Bee Hub.` }
  if (key.startsWith('added:')) {
    return { label: `Added on ${prettyDay(key.slice(6))}`, detail: `${count.toLocaleString('en-US')} ${people} with no history in Bee Hub, all added that day — most likely brought over from Jobber in one go.` }
  }
  return { label: 'No history in Bee Hub', detail: `No job, quote, request, card or note in Bee Hub yet. Often their history stayed in Jobber.` }
}

export function groupDefaultIn(key: string): boolean {
  return key !== 'archived'
}

// The one rule for a single person. The person's own tick wins, then their
// group's, then the default. Only people who COULD be offered are ever passed
// in (buildReview leaves everyone else out of `people`), so no choice can
// tick in someone who said no.
export function isIncluded(p: ReviewPerson, groupChoice: Record<string, 'in' | 'out' | null | undefined>): boolean {
  if (p.c === 'in') return true
  if (p.c === 'out') return false
  const g = groupChoice[p.g]
  if (g === 'in') return true
  if (g === 'out') return false
  return groupDefaultIn(p.g)
}

export function countAdding(people: readonly ReviewPerson[], groups: readonly ReviewGroup[], matchedByPhone?: ReadonlySet<string>): number {
  const gc: Record<string, 'in' | 'out' | null> = {}
  for (const g of groups) gc[g.key] = g.choice
  let n = 0
  for (const p of people) if (!matchedByPhone?.has(p.k) && isIncluded(p, gc)) n++
  return n
}

// The line under the big number, as parts that ADD UP (Kevin, 2026-11-26:
// "big 20, but 2 already · 21 new" read wrong — the 21 counted an unticked
// archived person the 20 did not). Everyone the screen is about is in exactly
// one part:
//   adding            new to Mailchimp and ticked — the big number
//   archivedUnticked  archived in Bee Hub, not ticked (shown on its own)
//   otherUnticked     anyone else not ticked (a group or a person unticked)
//   already           already in Mailchimp (by email, or matched by phone)
//   total             the sum of the four
export type ReviewTally = { adding: number; archivedUnticked: number; otherUnticked: number; already: number; total: number }
export function reviewTally(
  people: readonly ReviewPerson[], groups: readonly ReviewGroup[], sameSet: ReadonlySet<string>,
  m: Pick<ReviewModel, 'mailchimpKnown' | 'alreadyInMailchimp' | 'alreadyByPhone'>,
): ReviewTally {
  const gc: Record<string, 'in' | 'out' | null> = {}
  for (const g of groups) gc[g.key] = g.choice
  let adding = 0, archivedUnticked = 0, otherUnticked = 0
  for (const p of people) {
    if (sameSet.has(p.k)) continue
    if (isIncluded(p, gc)) adding++
    else if (p.g === 'archived') archivedUnticked++
    else otherUnticked++
  }
  const already = m.mailchimpKnown ? Math.max(0, m.alreadyInMailchimp - m.alreadyByPhone) + sameSet.size : 0
  return { adding, archivedUnticked, otherUnticked, already, total: adding + archivedUnticked + otherUnticked + already }
}

// The addresses the owner has said are already in Mailchimp under another
// email (phone answer "same").
export function matchedByPhone(phone: readonly PhoneSuggestion[]): Set<string> {
  const out = new Set<string>()
  for (const s of phone) if (s.answer === 'same') out.add(s.id.slice(s.id.indexOf('|') + 1))
  return out
}

// The words under the big number. The number itself is shown on its own line
// above, so this sentence starts with "person" / "people".
export function bigNumberWords(m: Pick<ReviewModel, 'adding' | 'mailchimpKnown'>, audienceName: string | null): string {
  const who = m.adding === 1 ? 'Person' : 'People'
  const where = audienceName ? `your Mailchimp audience “${audienceName}”` : 'your Mailchimp audience'
  if (!m.mailchimpKnown) return `${who} ticked to go to ${where}`
  return `${who} who will be added to ${where}`
}

export function buildReview(args: {
  leads: readonly ReviewLead[]
  contacted: ReadonlySet<string>        // lead ids with a job, quote, request, card or non-system touchpoint
  suppressed: ReadonlySet<string>       // addresses on the shared no-marketing list
  members: readonly ReviewMember[] | null   // null = Mailchimp could not be read in full
  choices: readonly StoredChoice[]
  timeZone: string
  bulkDayMin?: number
}): ReviewModel {
  const bulkMin = args.bulkDayMin ?? BULK_DAY_MIN
  const mailchimpKnown = args.members !== null
  const members = args.members || []

  // Bee Hub, by address.
  const byAddr = new Map<string, ReviewLead[]>()
  for (const l of args.leads) {
    const k = emailKey(l.email)
    if (!k) continue
    const list = byAddr.get(k)
    if (list) list.push(l); else byAddr.set(k, [l])
  }
  const noEmail = args.leads.filter((l) => !emailKey(l.email)).length

  // First member at each address (Mailchimp holds one per address; a stray
  // second is ignored, as slice 4 does).
  const memberByKey = new Map<string, ReviewMember>()
  const alreadyByStatus: Record<string, number> = {}
  for (const m of members) {
    if (!m.emailKey || memberByKey.has(m.emailKey)) continue
    memberByKey.set(m.emailKey, m)
  }

  const personChoice = new Map<string, 'in' | 'out'>()
  const groupChoice = new Map<string, 'in' | 'out'>()
  const phoneAnswer = new Map<string, 'same' | 'different'>()
  for (const c of args.choices) {
    if (c.scope === 'person' && (c.choice === 'in' || c.choice === 'out')) personChoice.set(c.key, c.choice)
    else if (c.scope === 'group' && (c.choice === 'in' || c.choice === 'out')) groupChoice.set(c.key, c.choice)
    else if (c.scope === 'phone' && (c.choice === 'same' || c.choice === 'different')) phoneAnswer.set(c.key, c.choice)
  }

  const byReason: Partial<Record<MailchimpIneligibleReason, number>> = {}
  if (noEmail) byReason.no_email = noEmail
  let notOfferedTotal = noEmail
  let already = 0

  type Candidate = { k: string; recs: ReviewLead[]; offered: ReviewLead[] }
  const candidates: Candidate[] = []
  for (const [k, recs] of Array.from(byAddr.entries())) {
    const offered = recs.filter((l) => mailchimpEligibility(l, { suppressed: args.suppressed }).eligible)
    const member = memberByKey.get(k)
    if (member) {
      already++
      bump(alreadyByStatus, member.status)
      continue
    }
    if (!offered.length) {
      const first = mailchimpEligibility(recs[0], { suppressed: args.suppressed })
      if (!first.eligible) { byReason[first.reason] = (byReason[first.reason] || 0) + 1; notOfferedTotal++ }
      continue
    }
    candidates.push({ k, recs, offered })
  }

  // Phone suggestions: Mailchimp members who matched nobody by email, whose
  // phone matches a Bee Hub person who is new to Mailchimp.
  const candByLead = new Map<string, Candidate>()
  for (const c of candidates) for (const l of c.recs) candByLead.set(l.id, c)
  const index = buildMatchIndex(candidates.flatMap((c) => c.recs.map((l) => ({ id: l.id, email: l.email, phone: l.phone }))))
  const phone: PhoneSuggestion[] = []
  const seenPair = new Set<string>()
  for (const m of members) {
    if (m.emailKey && byAddr.has(m.emailKey)) continue
    const v = matchContact({ id: m.id, email: m.email, phone: m.phone }, { byEmail: new Map(), byPhone: index.byPhone })
    if (v.kind !== 'phone_confirm') continue
    for (const leadId of v.ids) {
      const c = candByLead.get(leadId)
      if (!c) continue
      const id = `${m.id}|${c.k}`
      if (seenPair.has(id)) continue
      seenPair.add(id)
      const rep = c.offered[0]
      phone.push({ id, mailchimpEmail: m.email, mailchimpStatus: m.status, phone: m.phone, beeHubName: displayName(rep), beeHubEmail: (rep.email || '').trim(), answer: phoneAnswer.get(id) || null })
    }
  }
  const sameByPhone = matchedByPhone(phone)

  // Groups.
  // Everyone new stays in the list, phone-matched or not: an answer can be
  // changed back on the screen, and the person must still be there. A
  // "same person" answer only takes them out of the COUNT (countAdding's
  // third argument) and adds them to "already in your Mailchimp".
  const remaining = candidates
  const firstGroup = new Map<string, string>()
  const neverDay = new Map<string, string>()
  const dayCount: Record<string, number> = {}
  for (const c of remaining) {
    if (c.offered.every((l) => !!l.archived_at)) { firstGroup.set(c.k, 'archived'); continue }
    if (c.recs.some((l) => args.contacted.has(l.id))) { firstGroup.set(c.k, 'worked'); continue }
    const days = c.recs.map((l) => dayIn(l.created_at, args.timeZone)).filter((d): d is string => !!d).sort()
    const day = days[0] || 'unknown'
    neverDay.set(c.k, day)
    bump(dayCount, day)
  }
  const people: ReviewPerson[] = []
  const groupCount: Record<string, number> = {}
  for (const c of remaining) {
    let g = firstGroup.get(c.k)
    if (!g) {
      const day = neverDay.get(c.k)!
      g = day !== 'unknown' && dayCount[day] >= bulkMin ? `added:${day}` : 'never_other'
    }
    bump(groupCount, g)
    const rep = c.offered.find((l) => !l.archived_at) || c.offered[0]
    const p: ReviewPerson = { k: c.k, e: (rep.email || '').trim(), n: displayName(rep), g }
    if (g === 'archived') p.a = c.offered.map((l) => l.archived_at as string).sort().slice(-1)[0]
    const pc = personChoice.get(c.k)
    if (pc) p.c = pc
    people.push(p)
  }
  // Archived people first, so they are seen without searching or filtering
  // (Kevin: never hidden); then everyone by name.
  people.sort((a, b) => Number(b.g === 'archived') - Number(a.g === 'archived') || (a.n || a.e).localeCompare(b.n || b.e))

  const order = (k: string) => k === 'archived' ? 0 : k === 'worked' ? 1 : k === 'never_other' ? 3 : 2
  const groups: ReviewGroup[] = Object.keys(groupCount)
    .sort((a, b) => order(a) - order(b) || groupCount[b] - groupCount[a] || a.localeCompare(b))
    .map((key) => ({ key, ...groupWords(key, groupCount[key]), count: groupCount[key], defaultIn: groupDefaultIn(key), choice: groupChoice.get(key) || null }))

  return {
    mailchimpKnown,
    alreadyInMailchimp: already + sameByPhone.size,
    alreadyByPhone: sameByPhone.size,
    alreadyByStatus,
    notOffered: { total: notOfferedTotal, byReason },
    groups,
    people,
    phone,
    adding: countAdding(people, groups, sameByPhone),
  }
}

export const NOT_OFFERED_WORDS: Record<MailchimpIneligibleReason, string> = {
  no_email: 'no email address',
  junk: 'in the Recycle Bin',
  opted_out: 'marked “No marketing emails”',
  unsubscribed: 'unsubscribed',
  unsubscribed_elsewhere: 'said no to marketing at a Bee Organized location',
}
