// lib/lead-source-backfill.ts
//
// The decisions behind scripts/backfill-lead-source.mjs, kept here so they
// can be tested without Jobber or the database.
//
// WHAT IT IS FOR. Until 3b3c2fe (30 Sept 2026) Bee Hub never asked Jobber for
// a client's lead source, so every lead that arrived through the Jobber
// webhook landed with a blank source. Jobber still holds the answer. This
// fills the blank ones, once.
//
// THE RULES, in the order they are applied:
//   1. Only a lead whose source is STILL blank is touched. One an owner has
//      set since is left alone — at plan time and again at write time.
//   2. Jobber's value goes through leadSourceFromJobber — the SAME function
//      the live webhook path uses — so "google" and "Google" land as one
//      thing, an owner's own label comes through as typed, and Jobber's stamp
//      of our app name ("Bee Organized Interface") counts as blank.
//   3. Nothing but leads.source is written, so --undo can put it back exactly.

import { leadSourceFromJobber, JOBBER_APP_SOURCE_STAMP } from './lead-source'

export type BackfillLead = {
  id: string
  location_id: string
  jobber_client_id: string | null
  source: string | null
}

// What Jobber said about one client, read at run time.
export type JobberAnswer =
  | { kind: 'client'; leadSource: string | null }
  | { kind: 'gone' }                       // Jobber answered "no such client"
  | { kind: 'unreadable'; error: string }  // could not be read — never a blank

export type SourceFill = {
  id: string
  slug: string
  jobber_client_id: string
  jobberValue: string            // exactly as Jobber holds it
  before: { source: string | null }
  after: { source: string }
}

export type SourceBackfillPlan = {
  fills: SourceFill[]
  alreadySet: string[]       // an owner set a source since — left alone
  noSourceInJobber: string[] // Jobber has nothing either
  appStampOnly: string[]     // Jobber's only "source" is our own app name
  goneFromJobber: string[]
  unreadable: Array<{ id: string; error: string }>
}

export const isBlankSource = (v: unknown): boolean =>
  v == null || (typeof v === 'string' && v.trim() === '')

export function planSourceBackfill(
  leads: BackfillLead[],
  answers: Map<string, JobberAnswer>,
): SourceBackfillPlan {
  const plan: SourceBackfillPlan = {
    fills: [], alreadySet: [], noSourceInJobber: [], appStampOnly: [], goneFromJobber: [], unreadable: [],
  }
  for (const lead of leads) {
    if (!isBlankSource(lead.source)) { plan.alreadySet.push(lead.id); continue }
    const a = answers.get(lead.id)
    if (!a) { plan.unreadable.push({ id: lead.id, error: 'not asked' }); continue }
    if (a.kind === 'unreadable') { plan.unreadable.push({ id: lead.id, error: a.error }); continue }
    if (a.kind === 'gone') { plan.goneFromJobber.push(lead.id); continue }
    const raw = typeof a.leadSource === 'string' ? a.leadSource.trim() : ''
    if (!raw) { plan.noSourceInJobber.push(lead.id); continue }
    const mapped = leadSourceFromJobber(raw)
    if (!mapped) {
      // The only thing leadSourceFromJobber blanks out of a non-empty value
      // is our own app stamp.
      if (raw.toLowerCase() === JOBBER_APP_SOURCE_STAMP.toLowerCase()) plan.appStampOnly.push(lead.id)
      else plan.noSourceInJobber.push(lead.id)
      continue
    }
    plan.fills.push({
      id: lead.id,
      slug: lead.location_id,
      jobber_client_id: String(lead.jobber_client_id),
      jobberValue: raw,
      before: { source: lead.source ?? null },
      after: { source: mapped },
    })
  }
  return plan
}

// The one write the script is allowed to make: set leads.source on ONE lead,
// only if its source is currently exactly `expected`. Returns whether a row
// changed. The script backs this with a guarded PostgREST PATCH.
export type SourceWriter = (
  leadId: string,
  expected: string | null,
  next: string | null,
) => Promise<boolean>

export async function executeSourceBackfill(write: SourceWriter, fills: SourceFill[]) {
  const written: string[] = []
  const skipped: Array<{ id: string; why: string }> = []
  for (const f of fills) {
    try {
      // Guarded on the blank we planned against: a source set between the
      // read and this write is never overwritten.
      if (await write(f.id, f.before.source, f.after.source)) written.push(f.id)
      else skipped.push({ id: f.id, why: 'source was set since the plan was read — left alone' })
    } catch (e: any) {
      skipped.push({ id: f.id, why: e?.message || String(e) })
    }
  }
  return { written, skipped }
}

export async function undoSourceBackfill(write: SourceWriter, fills: SourceFill[]) {
  const reverted: string[] = []
  const skipped: Array<{ id: string; why: string }> = []
  for (const f of fills) {
    try {
      // Guarded on the value the run wrote: a source an owner has changed
      // since the run is theirs, and stays.
      if (await write(f.id, f.after.source, f.before.source)) reverted.push(f.id)
      else skipped.push({ id: f.id, why: 'no longer as the run left it — left alone' })
    } catch (e: any) {
      skipped.push({ id: f.id, why: e?.message || String(e) })
    }
  }
  return { reverted, skipped }
}

// ── pacing ──────────────────────────────────────────────────────────────────
// Jobber gives each account a budget of query points that refills steadily.
// Production (webhooks, sends) draws on the same budget, so the backfill never
// takes it below half: after each call it reads what is left and, if under
// the floor, waits for the refill. Returns the milliseconds to wait.
export const PACE_FLOOR = 0.5

export function paceWaitMs(
  throttle: { maximumAvailable?: number; currentlyAvailable?: number; restoreRate?: number } | null | undefined,
  floor = PACE_FLOOR,
): number {
  const max = Number(throttle?.maximumAvailable)
  const now = Number(throttle?.currentlyAvailable)
  const rate = Number(throttle?.restoreRate)
  if (!(max > 0) || !Number.isFinite(now) || !(rate > 0)) return 0
  const target = max * floor
  if (now >= target) return 0
  return Math.ceil(((target - now) / rate) * 1000)
}
