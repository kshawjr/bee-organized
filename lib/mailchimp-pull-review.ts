// FL-75 slice 7: the owner's review of who comes in from Mailchimp, and the
// confirmed import. Kevin (2026-11-26): no import without an owner review,
// built like slice 6's outgoing review: grouped, ticked, confirmed.
//
//   reviewModel(location)   READ ONLY. Who would be created (tickable), held
//                           (same phone, different email — the ONLY "same
//                           person?" case since 2026-11-27: shown beside the
//                           record it matches, answered one by one), skipped
//                           (counts by why).
//   importChosen(location, ids, count, by)
//                           Plans again from scratch, then creates ONLY the
//                           ticked people who are still "will be created". If
//                           the ticked list or the count no longer matches,
//                           nothing is created and the fresh review is sent
//                           back ("Something changed").
//
// Ticks are saved as the owner makes them (lib/mailchimp-import-choices.ts),
// only where they differ from "ticked", so they survive leaving the screen.
// The import trusts no saved tick on its own: it plans again from scratch and
// a tick can only pick among the people that plan says "will be created".
// Once someone is brought in, their saved choice is deleted (spent).
//
// "SAME PERSON?" ANSWERS (2026-11-27), kept in the same table, per person:
//   'out' = Same person — not added again (Bee Hub never merges)
//   'in'  = Different people — added as new, like anyone else
//   none  = Leave out for now (the default) — not added this time
// The "New to Bee Hub" group's tick never reaches a held person.
// Pilot locations only (lib/mailchimp-pull-pilot.ts).

import { supabaseService } from './supabase-service'
import { loadPull, applyPull, type PullPlan, type PullDecision, type ApplyResult } from './mailchimp-pull'
import { pullAllowed } from './mailchimp-pull-pilot'
import { emailKey } from './mailchimp-rules'
import { loadImportChoices, isTicked, spendImportChoices, type ImportChoices, type Tick } from './mailchimp-import-choices'

export const NOT_AVAILABLE_WORDS = 'Bringing people in from Mailchimp isn’t switched on for your location yet.'
const READ_WORDS: Record<string, string> = {
  audience_unreadable: 'Bee Hub couldn’t read your Mailchimp audience just now, so nothing can be brought in. Please try again in a few minutes.',
  audience_incomplete: 'Your Mailchimp audience changed while Bee Hub was reading it, so nothing can be brought in. Please try again in a few minutes.',
  staff_list_unreadable: 'Bee Hub couldn’t check for Bee Organized team addresses just now, so nothing can be brought in. Please try again.',
  records_unreadable: 'Bee Hub couldn’t read your clients just now, so nothing can be brought in. Please try again.',
  tags_unreadable: 'Bee Hub couldn’t read your tags just now, so nothing can be brought in. Please try again.',
}
const DEFAULT_WORDS = 'This screen could not be loaded. Please try again.'

export type ReviewPerson = { k: string; e: string; n: string | null; s: string; j: string | null; c?: Tick }
// p: the phone as Mailchimp has it. match: who they share it with — the Bee
// Hub person (phone_match) or the other Mailchimp entry (duplicate_in_mailchimp).
export type HeldPerson = ReviewPerson & { p: string | null; reason: string; match: { n: string | null; e: string | null; p: string | null } | null }
export type ImportModel = {
  location: { name: string; audienceId: string }
  choicesReady: boolean            // false until migrations/mailchimp_import_choices.sql is run
  group: Tick | null               // the "New to Bee Hub" group's saved choice; null = default (ticked)
  read: number
  create: ReviewPerson[]
  held: HeldPerson[]
  skipped: { total: number; byReason: Record<string, number> }
  already: number
}

const person = (m: any): ReviewPerson => ({ k: m.id, e: m.email, n: [m.firstName, m.lastName].filter(Boolean).join(' ') || null, s: m.status, j: m.joinedAt })

// A held person's own answer: only their person row counts, never the group.
export function heldAnswer(email: unknown, choices: Pick<ImportChoices, 'person'>): Tick | null {
  const k = emailKey(email)
  return (k && choices.person.get(k)) || null
}

async function buildModel(plan: PullPlan, loc: { id: string; name: string; audienceId: string }, db: any, choices: ImportChoices): Promise<ImportModel> {
  // The Bee Hub people a held person matches, named — only at THIS location.
  const ids = Array.from(new Set(plan.decisions.flatMap((d) => d.kind === 'held' && d.reason === 'phone_match' ? d.ids : [])))
  const named = new Map<string, { n: string | null; e: string | null; p: string | null }>()
  if (ids.length) {
    const { data, error } = await db.from('leads').select('id, name, email, phone').eq('location_uuid', loc.id).in('id', ids)
    if (error) throw new Error('held names unreadable')
    for (const r of data || []) named.set(r.id, { n: r.name || null, e: r.email || null, p: r.phone || null })
  }
  // The other Mailchimp entry, for two entries sharing a phone.
  const members = new Map<string, any>(plan.decisions.map((d) => [d.member.id, d.member]))
  const matchOf = (d: any) => {
    if (d.reason === 'duplicate_in_mailchimp') {
      const o = d.ids.map((id: string) => members.get(id)).find(Boolean)
      return o ? { n: [o.firstName, o.lastName].filter(Boolean).join(' ') || null, e: o.email || null, p: o.phone || null } : null
    }
    return d.ids.length && named.get(d.ids[0]) ? named.get(d.ids[0])! : null
  }
  const skipped: Record<string, number> = {}
  for (const [k, v] of Object.entries(plan.counts.skipped)) if (v) skipped[k] = v
  return {
    location: { name: loc.name, audienceId: loc.audienceId },
    choicesReady: choices.ready,
    group: choices.group,
    read: plan.counts.read,
    create: plan.decisions.filter((d) => d.kind === 'create').map((d) => {
      const c = choices.person.get(emailKey(d.member.email) || '')
      return c ? { ...person(d.member), c } : person(d.member)
    }),
    held: plan.decisions.filter((d) => d.kind === 'held').map((d: any) => {
      const c = heldAnswer(d.member.email, choices)
      return { ...person(d.member), ...(c ? { c } : {}), p: d.member.phone || null, reason: d.reason, match: matchOf(d) }
    }),
    skipped: { total: Object.values(skipped).reduce((a, b) => a + b, 0), byReason: skipped },
    already: plan.counts.already,
  }
}

type Fail = { ok: false; status: number; reason: string; words: string }

// The fresh plan's people to bring in: ticked creates, and held people
// answered "Different people" (they come in as a create, like anyone new).
export function chosenFrom(plan: PullPlan, choices: ImportChoices): Array<Extract<PullDecision, { kind: 'create' }>> {
  const out: Array<Extract<PullDecision, { kind: 'create' }>> = []
  for (const d of plan.decisions) {
    if (d.kind === 'create' && isTicked(d.member.email, choices)) out.push(d)
    else if (d.kind === 'held' && heldAnswer(d.member.email, choices) === 'in') out.push({ kind: 'create', member: d.member, unsubscribed: d.member.status === 'unsubscribed' })
  }
  return out
}

export async function reviewModel(locationUuid: string, deps: { db?: any; fetchImpl?: any } = {}): Promise<{ ok: true; model: ImportModel } | Fail> {
  if (!pullAllowed(locationUuid)) return { ok: false, status: 403, reason: 'not_available', words: NOT_AVAILABLE_WORDS }
  const db = deps.db || supabaseService
  const loaded = await loadPull(locationUuid, { db, fetchImpl: deps.fetchImpl })
  if (!loaded.ok) return { ok: false, status: 409, reason: loaded.reason, words: READ_WORDS[loaded.reason] || DEFAULT_WORDS }
  try {
    return { ok: true, model: await buildModel(loaded.plan, loaded.location, db, await loadImportChoices(locationUuid, db)) }
  } catch {
    return { ok: false, status: 500, reason: 'records_unreadable', words: READ_WORDS.records_unreadable }
  }
}

export type ImportAnswer =
  | { ok: true; created: number; createdUnsubscribed: number; alreadyThere: number; failed: Array<{ e: string; why: string }>; taggedPeople: number; notedPeople: number; quizPeople?: number; tagsFailed: number; runId: string }
  | { ok: false; status: number; reason: 'changed'; words: string; model: ImportModel }
  | Fail

export const CHANGED_WORDS = 'Something changed in Mailchimp or Bee Hub since you looked, so nobody was brought in. Here it is again.'

export async function importChosen(locationUuid: string, memberIds: unknown, count: unknown, by: string, deps: { db?: any; fetchImpl?: any; now?: () => number } = {}): Promise<ImportAnswer> {
  if (!pullAllowed(locationUuid)) return { ok: false, status: 403, reason: 'not_available', words: NOT_AVAILABLE_WORDS }
  const ids = Array.isArray(memberIds) ? Array.from(new Set(memberIds.filter((x): x is string => typeof x === 'string' && x.length > 0))) : null
  if (!ids || !ids.length || typeof count !== 'number' || count !== ids.length) {
    return { ok: false, status: 400, reason: 'bad_request', words: 'Tick at least one person, then confirm.' }
  }
  const db = deps.db || supabaseService
  const loaded = await loadPull(locationUuid, { db, fetchImpl: deps.fetchImpl })
  if (!loaded.ok) return { ok: false, status: 409, reason: loaded.reason, words: READ_WORDS[loaded.reason] || DEFAULT_WORDS }
  let choices: ImportChoices
  try { choices = await loadImportChoices(locationUuid, db) } catch { return { ok: false, status: 500, reason: 'records_unreadable', words: READ_WORDS.records_unreadable } }
  // Who is ticked now = the fresh plan's "will be created", filtered by the
  // saved ticks, plus the held people the owner answered "Different people".
  // The page must have shown exactly these people, or nobody comes in. A
  // saved tick for anyone outside the fresh plan counts for nothing.
  const chosen = chosenFrom(loaded.plan, choices)
  const want = new Set(ids)
  if (chosen.length !== ids.length || !chosen.every((d) => want.has(d.member.id))) {
    let model: ImportModel
    try { model = await buildModel(loaded.plan, loaded.location, db, choices) } catch { return { ok: false, status: 500, reason: 'records_unreadable', words: READ_WORDS.records_unreadable } }
    return { ok: false, status: 409, reason: 'changed', words: CHANGED_WORDS, model }
  }
  const runId = `mailchimp-import:${new Date((deps.now || Date.now)()).toISOString()}:${by}`
  const results: ApplyResult[] = await applyPull({ decisions: chosen, counts: loaded.plan.counts }, loaded.location, { db, runId, tags: loaded.tags, by })
  const tally = { created: 0, createdUnsubscribed: 0, alreadyThere: 0, failed: [] as Array<{ e: string; why: string }>, taggedPeople: 0, notedPeople: 0, quizPeople: 0, tagsFailed: 0 }
  for (const r of results) {
    if (r.outcome === 'created') tally.created++
    else if (r.outcome === 'created_unsubscribed') { tally.created++; tally.createdUnsubscribed++ }
    else if (r.outcome === 'already_there') tally.alreadyThere++
    else tally.failed.push({ e: r.email, why: r.outcome })
    if (r.tagsAttached?.length) tally.taggedPeople++
    if (r.tagsNoted?.length) tally.notedPeople++
    if (r.joinedByQuiz) tally.quizPeople++
    if (r.tagsFailed) tally.tagsFailed++
  }
  // Spent: whoever is now in Bee Hub has nothing left to choose.
  const spent = await spendImportChoices(locationUuid, results.filter((r) => r.outcome === 'created' || r.outcome === 'created_unsubscribed' || r.outcome === 'already_there').map((r) => r.email), db)
  if (!spent.ok) console.warn('[mailchimp-import] saved choices not cleared (harmless: they are in Bee Hub now, so never offered again)', locationUuid)
  console.info('[mailchimp-import]', JSON.stringify({ location: locationUuid, runId, chosen: chosen.length, created: tally.created, unsubscribed: tally.createdUnsubscribed, alreadyThere: tally.alreadyThere, failed: tally.failed.length }))
  return { ok: true, ...tally, runId }
}
