// components/hive/shared/leadDispositions.js
// ─────────────────────────────────────────────────────────────
// WHAT THE LEAD MENU SAYS — one source, so the Inbox row menu and the client
// card menu can never describe the same action two different ways.
//
// THE PROBLEM THIS SOLVES. Six items, no visible order, no explanation, and
// they fired instantly. Nobody could tell what Snooze, Dismiss and Junk
// actually did, or how Close differed from Junk — and that last confusion is
// the expensive one (see WHY BOTH STAY below).
//
// SNOOZE IS GONE FROM THE MENU, not from the database. Measured 2026-09-16:
// snoozed_until has been set 8 times in the platform's life across 5
// locations, 3 of them still in the future. inbox_dismissed_at has been set
// 157 times. Snooze took two of six slots for something nobody reaches for,
// and Dismiss already covers "not now" — with the dismissed shelf shipped,
// nothing is lost. The COLUMN, isSoftRemovedFromInbox's snooze test, the
// snooze display on the card and the un-snooze path all remain, because
// those 3 live leads must keep behaving correctly until they wake naturally.
// Removing the way IN was the job; removing the plumbing was not.
//
// WHY CLOSE AND JUNK BOTH STAY — do not merge them later. Verified in the
// code, not assumed:
//   · Close founds and closes a Closed Lost engagement. 'Closed Lost' is a
//     real terminal stage in stageConfig's `lost` bucket, so the deal stays
//     in reporting AS A LOST OPPORTUNITY — which is what an owner wants to
//     see: real enquiries they didn't win.
//   · Junk sets is_junk, and every loading query filters `is_junk IS NOT
//     TRUE` (app/_hub-page.tsx, lib/hub-all-overview.ts). A junked lead
//     leaves reporting ENTIRELY.
// Merging them would put website spam permanently into the conversion
// numbers. They look similar in a menu and are opposites in the data, which
// is exactly why the junk confirmation ends by pointing at Close.
//
// PURE: no React, no tokens, no fetch. Safe in any bundle.
// ─────────────────────────────────────────────────────────────

// The three groups, in the order Kevin approved, each with the items under it.
//
// "Keep them as a contact" is NOT the heading first drafted for the Network
// group ("Hand it on"). That heading described passing the lead to another
// Bee Organized location, which is NOT what this does — that is the separate
// Route button on an unrouted lead. NetworkConvertSheet offers two outcomes
// and BOTH keep the person as a Network contact: Add (they stay in the
// pipeline too) or Move (they were never really a client). The heading now
// says the thing both outcomes have in common.
export const DISPOSITION_GROUPS = [
  {
    key: 'off-list',
    heading: 'Take it off your list',
    items: ['dismiss'],
  },
  {
    key: 'contact',
    heading: 'Keep them as a contact',
    items: ['network'],
  },
  {
    key: 'finish',
    heading: 'Finish with it',
    items: ['close', 'junk'],
  },
]

// Every description below was checked against what the code ACTUALLY does,
// not against the label.
export const DISPOSITIONS = {
  dismiss: {
    key: 'dismiss',
    label: 'Dismiss',
    // Verified: dismissLead PATCHes inbox_dismissed_at and logs a system
    // touchpoint. It does NOT touch drips and does NOT change status — the
    // person stays on the Client List and keeps deriving New/Attempting.
    description: 'Still a live client, just not on your worklist',
  },
  network: {
    key: 'network',
    label: 'Add to Network…',
    // Verified against NetworkConvertSheet's own MODES: one door, two
    // outcomes chosen at press time. Add = "they stay a client too — same
    // place in the pipeline, plus a Network record". Move = "never really a
    // client; leaves the Inbox and pauses their drip emails". The ellipsis is
    // load-bearing: it opens a sheet that explains both before anything is
    // written.
    description: 'Files them in your Network as a contact — you choose whether they stay a client too',
  },
  close: {
    key: 'close',
    label: 'Close',
    // Verified: founds + closes a Closed Lost engagement and stops the
    // lead's drips. Kevin's approved wording, kept verbatim. It does not
    // mention the drips stopping — see the report; the wizard's own
    // follow-up step is where that currently surfaces.
    description: 'A real enquiry that didn’t go ahead. Counts as lost.',
  },
  junk: {
    key: 'junk',
    // Capital J (Kevin, 2026-09-16): Junk is a PLACE here — the Recycle Bin
    // the record moves to — not a description of it. The confirmation and its
    // verb carry the same capital so the label and its own confirmation can
    // never read as two different things.
    label: 'Mark as Junk',
    // Verified: is_junk true → the Recycle Bin, drips stopped
    // (drip-lifecycle stopActiveDripsForLead 'junk'), and filtered out of
    // every loading query, so out of the numbers.
    description: 'Never a real enquiry. Goes to the Recycle Bin and out of your numbers.',
    danger: true,
  },
}

// ── the confirmations ────────────────────────────────────────────
// SAME WORDS AS THE MENU, deliberately: the description an owner just read is
// the sentence they are asked to confirm, so the confirm teaches rather than
// merely interrupting.
//
// Only the two that used to fire INSTANTLY carry one. "Add to Network…" and
// "Close" already open a step that explains itself before writing anything —
// the sheet spells out Add vs Move, and the wizard asks for a reason — so a
// confirm in front of either would be a confirm before a confirm.
export const CONFIRMABLE = ['dismiss', 'junk']

export function confirmPrompt(key, name) {
  const who = (name || '').trim() || 'this lead'
  if (key === 'dismiss') {
    return `Dismiss ${who}? ${DISPOSITIONS.dismiss.description}.`
  }
  if (key === 'junk') {
    // THE POINTER TO CLOSE IS THE POINT. Close and junk are opposites in the
    // data and look alike in a menu; the moment someone is about to choose
    // wrong is the cheapest place to catch it.
    return `Mark ${who} as Junk? ${DISPOSITIONS.junk.description} Their drip emails stop. ${JUNK_POINTS_TO_CLOSE}`
  }
  return null
}

export const JUNK_POINTS_TO_CLOSE =
  'If they were a real person who just didn’t go ahead, use Close instead.'

export const CONFIRM_YES = { dismiss: 'Yes, dismiss', junk: 'Yes, mark as Junk' }
export const CONFIRM_NO = 'Keep it'
