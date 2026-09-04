// lib/enquiry-exit.ts
// ─────────────────────────────────────────────────────────────
// ONE definition of "is this enquiry still open" — Kevin's Inbox rule
// (2026-09-03) — shared by the Inbox derivation (components/hive/shared/
// clientStatus.js), the 35-day auto-close (lib/auto-close.ts), the corporate
// Home tile and the Mailchimp tag, so no two of them can ever disagree about
// who is in the Inbox and who has been closed.
//
// An ENQUIRY is a website or hand-entered lead (import_source 'manual'), or
// ANY lead that filled in the website form again (a 'Webform resubmission'
// touchpoint — Jobber clients included). Its enquiry date is the later of the
// lead's created date and its latest resubmission.
//
// It stays in the Inbox until one of four things happens (three of them AFTER the
// enquiry date. Nothing else takes it out — not age, not founding an
// engagement, not a logged call:
//   1. Send to Jobber — a service request, quote or job dated after the
//      enquiry (or a request / job id stamped on the lead when there was no
//      resubmission). NEVER the bare jobber_client_id: the import stamps one
//      when it adopts a website lead by email, and that person was never sent.
//   2. A Network MOVE — a partners row pointing at the lead with is_customer
//      false. An "add" leaves the person a live enquiry.
//   3. A close after the enquiry — Closed Won, Closed Lost, or junk. A Jobber
//      client closed Lost on import in July who fills in the form in August
//      is a new enquiry.
//
//   4. No contact details — no email AND no phone (Kevin, 2026-09-04: nobody
//      can work someone they cannot reach). This one is a WORKLIST exit, not
//      a close: the person leaves the Inbox and the badge, but the enquiry is
//      still open in the sense the auto-close reads (`open`), so it closes at
//      35 days like any other unanswered enquiry. `inbox` = open AND reachable.
//
// Dismiss and snooze are HOLDS, not exits (isSoftRemovedFromInbox). They hide
// the row; they never change what this module answers.
//
// New vs Attempting: whether a reach-out has been logged since the enquiry.
//
// Pure: no I/O, no clock beyond the timestamps handed in. Callers assemble
// EnquiryFacts from whatever rows they hold (factsFromRows is the one
// assembler for raw DB rows; the people-mapper uses it).
// ─────────────────────────────────────────────────────────────

export const WEBFORM_RESUBMISSION_LABEL = 'Webform resubmission'

// A request the send-to-jobber route writes lands a few hundred ms after the
// enquiry it answers; the minute of slack keeps that from reading as "before".
export const EXIT_SLACK_MS = 60 * 1000

export type EnquiryExit = 'jobber' | 'network' | 'closed' | 'junk'

export interface EnquiryFacts {
  createdAt: string | null | undefined
  importSource: string | null | undefined
  jobberRequestId?: string | null
  jobberJobId?: string | null
  /** occurred_at of every 'Webform resubmission' touchpoint. */
  resubmissionAts: string[]
  /** occurred_at of every logged reach-out (the caller passes the live set). */
  reachOutAts: string[]
  /** service request requested/created, quote created, job created. */
  jobberWorkAts: string[]
  networkMoved: boolean
  /** closed_at of every Closed Won / Closed Lost engagement. */
  closedAts: string[]
  isJunk?: boolean | null
  /** Contact details — exit 4 is having neither. */
  email?: string | null
  phone?: string | null
}

export interface EnquiryState {
  isEnquiry: boolean
  /** epoch ms; 0 when the lead has no usable date. */
  enquiryAt: number
  exit: EnquiryExit | null
  /** isEnquiry and none of the three closing exits — what the auto-close reads. */
  open: boolean
  /** an email or a phone — exit 4 is lacking both. */
  reachable: boolean
  /** open AND reachable — the person belongs in the Inbox and the badge. */
  inbox: boolean
  /** a reach-out on or after the enquiry date. */
  reachedSince: boolean
}

export interface EnquirySession {
  /** Sent to Jobber this session (the optimistic 'REQ-…' / 'JOB-…' ref). */
  sentThisSession?: boolean
  /** Closed this session, before the refetch lands. */
  closedThisSession?: boolean
}

const ms = (iso: string | null | undefined): number => (iso ? new Date(iso).getTime() || 0 : 0)
const maxMs = (isos: (string | null | undefined)[] | null | undefined): number =>
  (isos || []).reduce((m, iso) => Math.max(m, ms(iso)), 0)

export function enquiryDateMs(f: Pick<EnquiryFacts, 'createdAt' | 'resubmissionAts'>): number {
  return Math.max(ms(f.createdAt), maxMs(f.resubmissionAts))
}

export function isEnquiryLead(f: Pick<EnquiryFacts, 'importSource' | 'resubmissionAts'>): boolean {
  return f.importSource === 'manual' || (f.resubmissionAts || []).length > 0
}

export function enquiryState(f: EnquiryFacts, session: EnquirySession = {}): EnquiryState {
  const isEnquiry = isEnquiryLead(f)
  const enquiryAt = enquiryDateMs(f)
  const since = enquiryAt - EXIT_SLACK_MS
  const hadResub = (f.resubmissionAts || []).length > 0

  let exit: EnquiryExit | null = null
  if (f.isJunk === true) exit = 'junk'
  else if (
    session.sentThisSession ||
    (f.jobberWorkAts || []).some((iso) => ms(iso) >= since) ||
    (!hadResub && (!!f.jobberRequestId || !!f.jobberJobId))
  ) exit = 'jobber'
  else if (f.networkMoved) exit = 'network'
  else if (session.closedThisSession || (f.closedAts || []).some((iso) => ms(iso) >= since)) exit = 'closed'

  const open = isEnquiry && enquiryAt > 0 && exit === null
  const reachable = !!((f.email || '').trim() || (f.phone || '').trim())
  const reachedSince = (f.reachOutAts || []).some((iso) => ms(iso) >= enquiryAt)
  return { isEnquiry, enquiryAt, exit, open, reachable, inbox: open && reachable, reachedSince }
}

// ── Assembling facts from raw rows ──────────────────────────────

export interface EnquiryLeadRow {
  created_at?: string | null
  import_source?: string | null
  jobber_request_id?: string | null
  jobber_job_id?: string | null
  is_junk?: boolean | null
  email?: string | null
  phone?: string | null
}

export interface EnquiryRowInputs {
  lead: EnquiryLeadRow
  /** touchpoints rows (kind, label, occurred_at) */
  touchpoints?: { kind?: string | null; label?: string | null; occurred_at?: string | null }[] | null
  service_requests?: { requested_at?: string | null; created_at?: string | null }[] | null
  quotes?: { created_at?: string | null }[] | null
  jobs?: { created_at?: string | null }[] | null
  /** engagements rows (stage, closed_at) — closed ones are read */
  engagements?: { stage?: string | null; closed_at?: string | null }[] | null
  /** already-rolled-up alternative to `engagements` */
  closedAts?: string[] | null
  networkMoved?: boolean | null
}

const isoOnly = (xs: (string | null | undefined)[]): string[] => xs.filter((x): x is string => !!x)

export function factsFromRows(input: EnquiryRowInputs): EnquiryFacts {
  const tps = input.touchpoints || []
  const closedFromRows = (input.engagements || [])
    .filter((e) => e.stage === 'Closed Won' || e.stage === 'Closed Lost')
    .map((e) => e.closed_at)
  return {
    createdAt: input.lead.created_at ?? null,
    importSource: input.lead.import_source ?? null,
    jobberRequestId: input.lead.jobber_request_id ?? null,
    jobberJobId: input.lead.jobber_job_id ?? null,
    resubmissionAts: isoOnly(tps.filter((t) => t.label === WEBFORM_RESUBMISSION_LABEL).map((t) => t.occurred_at)),
    reachOutAts: isoOnly(tps.filter((t) => t.kind === 'reach_out').map((t) => t.occurred_at)),
    jobberWorkAts: isoOnly([
      ...(input.service_requests || []).map((s) => s.requested_at || s.created_at),
      ...(input.quotes || []).map((q) => q.created_at),
      ...(input.jobs || []).map((j) => j.created_at),
    ]),
    networkMoved: input.networkMoved === true,
    closedAts: isoOnly([...(input.closedAts || []), ...closedFromRows]),
    isJunk: input.lead.is_junk ?? false,
    email: input.lead.email ?? null,
    phone: input.lead.phone ?? null,
  }
}
