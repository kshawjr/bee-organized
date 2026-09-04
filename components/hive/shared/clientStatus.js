// components/hive/shared/clientStatus.js
// ─────────────────────────────────────────────────────────────
// PURE module — client status DERIVATION. The one place every surface asks
// "what is this person to us": the Inbox list and badge, the hidden-by-
// filters strip, the Home tile, the People directory bands, the profile chip,
// the Mailchimp tag and the corporate Home tile all call deriveClientStatus.
//
// THE INBOX RULE (Kevin, 2026-09-03 — replaces the 30-day clock and the
// "Back again" exception):
//
//   An enquiry is in the Inbox until one of four things happens, and
//   nothing else: Send to Jobber, a Network move, a close, or having no
//   way to reach them (no email and no phone). No clock. Founding an
//   engagement does not remove anyone. A logged call does not.
//
// The exits live in ONE shared helper, lib/enquiry-exit.ts, which the 35-day
// auto-close reads too — so the Inbox and the auto-close can never disagree
// about who is closed. person.enquiryFacts (lib/people-mapper.ts) carries
// everything that helper needs except the live reach-outs, which are read
// from outreachTimeline here so a call logged this session flips the row
// without a reload.
//
// STATUSES, checked in order:
//   New        — an open enquiry with no reach-out logged since the enquiry.
//   Attempting — an open enquiry with a reach-out since the enquiry.
//                (Together these ARE the Inbox: isInboxCountable is this
//                test plus the soft-removal holds — dismiss and snooze hide a
//                row without changing its status.)
//   no_contact — no email AND no phone: exit 4 (Kevin, 2026-09-04). Never
//                New/Attempting; the auto-close still closes it at 35 days.
//   Active     — ≥1 OPEN engagement (being worked, after an exit).
//   Client     — ≥1 CLOSED WON engagement, ever (the live wonClientIds set
//                OR person.wonEngagements) — a customer, not a lead.
//   Past       — no won engagement AND paid history (paidAmount > 0).
//   Nurturing  — everyone else: exited and not won. The marketable pool.
//
// Session-live inputs: openClientIds / wonClientIds are the session's truth
// for engagements (a close this session drops Active → Client immediately);
// session.closedIds marks a lead closed this session before the refetch
// lands (the Inbox passes its closedLostIds); a fresh Send to Jobber shows
// as an optimistic 'REQ-…' / 'JOB-…' jobberRef and counts as exit 1.
// ─────────────────────────────────────────────────────────────

import { enquiryState, enquiryDateMs, WEBFORM_RESUBMISSION_LABEL } from '@/lib/enquiry-exit'

export const CLIENT_STATUS_ORDER = ['New', 'Attempting', 'Nurturing', 'Active', 'Client', 'Past', 'no_contact']

const SENT_THIS_SESSION = /^(REQ|JOB)-/

function reachOutAtsOf(person) {
  return (person.outreachTimeline || [])
    .filter(t => t.type === 'reach_out' && t.occurred_at)
    .map(t => t.occurred_at)
}

// person.enquiryFacts is the mapper's roll-up. A caller that builds a person
// by hand (older tests, fixtures) may omit it: the timeline still carries the
// resubmission touchpoints, and a won roll-up is itself a close, so the
// enquiry date and exit 3 survive without it.
function factsOf(person) {
  const base = person.enquiryFacts || {
    createdAt: person.created || null,
    importSource: person.importSource ?? 'manual',
    jobberRequestId: null,
    jobberJobId: null,
    resubmissionAts: (person.outreachTimeline || [])
      .filter(t => t.label === WEBFORM_RESUBMISSION_LABEL && t.occurred_at)
      .map(t => t.occurred_at),
    jobberWorkAts: [],
    networkMoved: false,
    closedAts: person.wonEngagements?.lastClosedAt ? [person.wonEngagements.lastClosedAt] : [],
  }
  return { ...base, reachOutAts: reachOutAtsOf(person), isJunk: !!person.isJunk, email: person.email || null, phone: person.phone || null }
}

/**
 * The enquiry state for a person — exported for the Inbox row and tests.
 * A Closed Won this session (the live wonClientIds set) is a close this
 * session: exit 3 before the refetch lands, same as the Inbox's closedIds.
 */
export function enquiryStateOf(person, session = {}) {
  return enquiryState(factsOf(person), {
    sentThisSession: SENT_THIS_SESSION.test(person.jobberRef || ''),
    closedThisSession: !!(
      (session.closedIds && session.closedIds.has(person.id)) ||
      (session.wonIds && session.wonIds.has(person.id))
    ),
  })
}

/** ISO of the enquiry date (created, or the latest website resubmission). */
export function enquiryDateOf(person) {
  const t = enquiryDateMs(factsOf(person))
  return t > 0 ? new Date(t).toISOString() : (person.created || null)
}

/**
 * "Back again" — a past client's new website enquiry. Keyed on the
 * resubmission touchpoint (not on any derivation): the person filled in the
 * form again AND has history with us (came from Jobber, won, or paid).
 */
export function isBackAgain(person) {
  const f = factsOf(person)
  if ((f.resubmissionAts || []).length === 0) return false
  return f.importSource !== 'manual'
    || (person.wonEngagements?.count > 0)
    || (Number(person.paidAmount) || 0) > 0
}

export function deriveClientStatus(person, openClientIds, nowMs = Date.now(), wonClientIds = null, session = {}) {
  const st = enquiryStateOf(person, { ...session, wonIds: wonClientIds })
  // inbox = open AND reachable. Exit 4 (no email, no phone) keeps a person
  // out of the worklist — nobody can work someone they cannot reach — while
  // the auto-close still reads them as open and closes them at 35 days.
  if (st.inbox) return st.reachedSince ? 'Attempting' : 'New'

  if (!st.reachable) return 'no_contact'

  if (openClientIds && openClientIds.has(person.id)) return 'Active'

  if ((wonClientIds && wonClientIds.has(person.id)) || (person.wonEngagements?.count > 0)) return 'Client'

  if ((Number(person.paidAmount) || 0) > 0) return 'Past'

  return 'Nurturing'
}

// Display config for the directory: chip styleKey + label per status.
export const CLIENT_STATUS_META = {
  New:        { label: 'New',             styleKey: 'New' },
  Attempting: { label: 'Attempting',      styleKey: 'Attempting' },
  Nurturing:  { label: 'Nurturing',       styleKey: 'Nurturing' },
  Active:     { label: 'Active',          styleKey: 'Active' },
  Client:     { label: 'Client',          styleKey: 'Client' },
  Past:       { label: 'Past client',     styleKey: 'Past' },
  no_contact: { label: 'No contact info', styleKey: 'quiet' },
}
