// FL-75 slice 7: the owner's review of who comes in from Mailchimp, and the
// confirmed import. Kevin (2026-11-26): no import without an owner review,
// built like slice 6's outgoing review: grouped, ticked, confirmed.
//
//   reviewModel(location)   READ ONLY. Who would be created (tickable), held
//                           (a phone or name match: shown with the record it
//                           matches, never tickable), skipped (counts by why).
//   importChosen(location, ids, count, by)
//                           Plans again from scratch, then creates ONLY the
//                           ticked people who are still "will be created". If
//                           the ticked list or the count no longer matches,
//                           nothing is created and the fresh review is sent
//                           back ("Something changed").
//
// Ticks are not saved anywhere (no migration): they live on the page until
// the owner confirms. Pilot locations only (lib/mailchimp-pull-pilot.ts).

import { supabaseService } from './supabase-service'
import { loadPull, applyPull, type PullPlan, type ApplyResult } from './mailchimp-pull'
import { pullAllowed } from './mailchimp-pull-pilot'

export const NOT_AVAILABLE_WORDS = 'Bringing people in from Mailchimp isn’t switched on for your location yet.'
const READ_WORDS: Record<string, string> = {
  audience_unreadable: 'Bee Hub couldn’t read your Mailchimp audience just now, so nothing can be brought in. Please try again in a few minutes.',
  audience_incomplete: 'Your Mailchimp audience changed while Bee Hub was reading it, so nothing can be brought in. Please try again in a few minutes.',
  staff_list_unreadable: 'Bee Hub couldn’t check for Bee Organized team addresses just now, so nothing can be brought in. Please try again.',
  records_unreadable: 'Bee Hub couldn’t read your records just now, so nothing can be brought in. Please try again.',
}
const DEFAULT_WORDS = 'This screen could not be loaded. Please try again.'

export type ReviewPerson = { k: string; e: string; n: string | null; s: string; j: string | null }
export type HeldPerson = ReviewPerson & { reason: string; match: { n: string | null; e: string | null } | null }
export type ImportModel = {
  location: { name: string; audienceId: string }
  read: number
  create: ReviewPerson[]
  held: HeldPerson[]
  skipped: { total: number; byReason: Record<string, number> }
  already: number
}

const person = (m: any): ReviewPerson => ({ k: m.id, e: m.email, n: [m.firstName, m.lastName].filter(Boolean).join(' ') || null, s: m.status, j: m.joinedAt })

async function buildModel(plan: PullPlan, loc: { id: string; name: string; audienceId: string }, db: any): Promise<ImportModel> {
  // The records a held person matches, named — only records at THIS location.
  const ids = Array.from(new Set(plan.decisions.flatMap((d) => d.kind === 'held' && d.reason !== 'other_location' && d.reason !== 'duplicate_in_mailchimp' ? d.ids : [])))
  const named = new Map<string, { n: string | null; e: string | null }>()
  if (ids.length) {
    const { data, error } = await db.from('leads').select('id, name, email').eq('location_uuid', loc.id).in('id', ids)
    if (error) throw new Error('held names unreadable')
    for (const r of data || []) named.set(r.id, { n: r.name || null, e: r.email || null })
  }
  const skipped: Record<string, number> = {}
  for (const [k, v] of Object.entries(plan.counts.skipped)) if (v) skipped[k] = v
  return {
    location: { name: loc.name, audienceId: loc.audienceId },
    read: plan.counts.read,
    create: plan.decisions.filter((d) => d.kind === 'create').map((d) => person(d.member)),
    held: plan.decisions.filter((d) => d.kind === 'held').map((d: any) => ({ ...person(d.member), reason: d.reason, match: d.ids.length && named.get(d.ids[0]) ? named.get(d.ids[0])! : null })),
    skipped: { total: Object.values(skipped).reduce((a, b) => a + b, 0), byReason: skipped },
    already: plan.counts.already,
  }
}

type Fail = { ok: false; status: number; reason: string; words: string }

export async function reviewModel(locationUuid: string, deps: { db?: any; fetchImpl?: any } = {}): Promise<{ ok: true; model: ImportModel } | Fail> {
  if (!pullAllowed(locationUuid)) return { ok: false, status: 403, reason: 'not_available', words: NOT_AVAILABLE_WORDS }
  const db = deps.db || supabaseService
  const loaded = await loadPull(locationUuid, { db, fetchImpl: deps.fetchImpl })
  if (!loaded.ok) return { ok: false, status: 409, reason: loaded.reason, words: READ_WORDS[loaded.reason] || DEFAULT_WORDS }
  try {
    return { ok: true, model: await buildModel(loaded.plan, loaded.location, db) }
  } catch {
    return { ok: false, status: 500, reason: 'records_unreadable', words: READ_WORDS.records_unreadable }
  }
}

export type ImportAnswer =
  | { ok: true; created: number; createdUnsubscribed: number; alreadyThere: number; failed: Array<{ e: string; why: string }>; runId: string }
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
  const want = new Set(ids)
  const chosen = loaded.plan.decisions.filter((d) => d.kind === 'create' && want.has(d.member.id))
  if (chosen.length !== ids.length) {
    let model: ImportModel
    try { model = await buildModel(loaded.plan, loaded.location, db) } catch { return { ok: false, status: 500, reason: 'records_unreadable', words: READ_WORDS.records_unreadable } }
    return { ok: false, status: 409, reason: 'changed', words: CHANGED_WORDS, model }
  }
  const runId = `mailchimp-import:${new Date((deps.now || Date.now)()).toISOString()}:${by}`
  const results: ApplyResult[] = await applyPull({ decisions: chosen, counts: loaded.plan.counts }, loaded.location, { db, runId })
  const tally = { created: 0, createdUnsubscribed: 0, alreadyThere: 0, failed: [] as Array<{ e: string; why: string }> }
  for (const r of results) {
    if (r.outcome === 'created') tally.created++
    else if (r.outcome === 'created_unsubscribed') { tally.created++; tally.createdUnsubscribed++ }
    else if (r.outcome === 'already_there') tally.alreadyThere++
    else tally.failed.push({ e: r.email, why: r.outcome })
  }
  console.info('[mailchimp-import]', JSON.stringify({ location: locationUuid, runId, chosen: chosen.length, created: tally.created, unsubscribed: tally.createdUnsubscribed, alreadyThere: tally.alreadyThere, failed: tally.failed.length }))
  return { ok: true, ...tally, runId }
}
