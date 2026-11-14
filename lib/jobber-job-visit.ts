// lib/jobber-job-visit.ts
//
// The visit on a job sent from Bee Hub (Send to Jobber → Create a Job).
//
// WHY THIS EXISTS. A job created in Jobber with only a start date has NO
// visit — proven on Test Location 2026-11-14 (job #3: timeframe.startAt only,
// visits: []). Jobber's calendar shows visits, so a date-only job never
// appears on it. That is what Ankur Patel (Palm Beach) reported on 17 Oct.
//
// HOW. The job is created exactly as before (date only). Then, ONLY when the
// owner picked a start time, a second call adds one visit to that job:
//   visitCreate(jobId, { visits: [{ schedule: { startAt, endAt? } }] })
// Two calls, not one, on purpose:
//   · the job create is byte-for-byte what it always was, so a send with no
//     time is exactly today's send;
//   · if Jobber refuses the visit, the job already exists and stays — the
//     owner is told the time did not book, never that the job failed;
//   · the time carries the LOCATION's own IANA time zone (LocalDateTimeAttributes
//     is { date, time, timezone }), so 9:00 means 9:00 where the owner is —
//     never the browser's zone, never UTC. (jobCreate's own scheduling block
//     takes a bare time with no zone; it would use whatever zone the Jobber
//     account is set to.)
//
// LENGTH. The owner may give an end time. With none, endAt is left off and
// Jobber books its own default length (2 hours on Test Location, 2026-11-14).
// No length is invented here.
//
// notifyTeam is deliberately left UNSET, as on the assessment path: anything
// that emails a franchise team member needs Kevin's ok first.

import { jobberMutation } from '@/lib/jobber'
import { requireIanaTimezone } from '@/lib/drip-time'

// VisitCreatePayload's list is `createdVisits` (introspected live 2026-11-14;
// `visits` does not exist on it and is a top-level GraphQL error).
export const VISIT_CREATE_MUTATION = /* GraphQL */ `
  mutation JobVisitCreate($jobId: EncodedId!, $input: VisitCreateInput!) {
    visitCreate(jobId: $jobId, input: $input) {
      createdVisits { id startAt endAt }
      userErrors { message path }
    }
  }
`

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

export type VisitTimes = { start: string; end: string | null }

// Validate the optional start/end the form sends ("HH:mm", 24-hour, the
// owner's own wall clock). Returns null when no time was asked for — the
// date-only send, untouched. A time without a date, a malformed time, or an
// end not after the start is refused BEFORE anything is written to Jobber.
export function parseVisitTimes(
  date: string | null,
  rawStart: unknown,
  rawEnd: unknown,
): { ok: true; times: VisitTimes | null } | { ok: false; error: string } {
  const start = typeof rawStart === 'string' ? rawStart.trim() : ''
  const end = typeof rawEnd === 'string' ? rawEnd.trim() : ''
  if (!start && !end) return { ok: true, times: null }
  if (!start) return { ok: false, error: 'Cannot create a job: an end time needs a start time.' }
  if (!date) return { ok: false, error: 'Cannot create a job: a start time needs a date.' }
  if (!HHMM.test(start)) return { ok: false, error: `Cannot create a job: start time is not a valid time ("${start}").` }
  if (end) {
    if (!HHMM.test(end)) return { ok: false, error: `Cannot create a job: end time is not a valid time ("${end}").` }
    if (end <= start) return { ok: false, error: 'Cannot create a job: the end time must be after the start time.' }
  }
  return { ok: true, times: { start, end: end || null } }
}

// The location's zone, or the owner-facing reason there is none. Checked
// before the job is created, so a missing zone never half-sends.
export function visitTimezone(label: unknown): { ok: true; tz: string } | { ok: false; error: string } {
  try {
    return { ok: true, tz: requireIanaTimezone(label as any) }
  } catch {
    return {
      ok: false,
      error: "Cannot book a time: this location's time zone isn't set. Set it under Settings › Location, or send the job without a time.",
    }
  }
}

// The schedule Jobber is sent. Pure, so the time-zone rule is pinned on its own.
export function buildVisitSchedule(date: string, times: VisitTimes, tz: string) {
  return {
    startAt: { date, time: `${times.start}:00`, timezone: tz },
    ...(times.end ? { endAt: { date, time: `${times.end}:00`, timezone: tz } } : {}),
  }
}

export type BookVisitResult =
  | { booked: true; visitId: string | null; startAt: string | null; endAt: string | null }
  | { booked: false; error: string }

// Never throws: the job already exists when this runs, and nothing here may
// turn a created job into a failed send.
export async function bookJobVisit(args: {
  locationSlug: string
  jobGlobalId: string
  date: string
  times: VisitTimes
  tz: string
}): Promise<BookVisitResult> {
  try {
    const res = await jobberMutation(args.locationSlug, VISIT_CREATE_MUTATION, {
      jobId: args.jobGlobalId,
      input: { visits: [{ schedule: buildVisitSchedule(args.date, args.times, args.tz) }] },
    })
    if (res.userErrors?.length) return { booked: false, error: res.userErrors[0].message || 'Jobber refused the visit' }
    const v = res.data?.visitCreate?.createdVisits?.[0]
    if (!v) return { booked: false, error: 'Jobber returned no visit' }
    return { booked: true, visitId: v.id || null, startAt: v.startAt || null, endAt: v.endAt || null }
  } catch (e: any) {
    return { booked: false, error: String(e?.message || e || 'Jobber did not answer').slice(0, 200) }
  }
}
