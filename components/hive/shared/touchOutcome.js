// components/hive/shared/touchOutcome.js
// ─────────────────────────────────────────────────────────────
// THE one opinion about a reach-out's OUTCOME — the optional
// "Reached / No answer / Left voicemail" picked when logging a call, text,
// email or visit. It is stored in touchpoints.status.
//
// WHY THIS FILE EXISTS. The outcome picker shipped on 2026-07-15 on the
// belief that the outcome was "already rendered by Timeline". That was true
// of ONE place, and only after tapping a row open. Recent activity — the list
// owners actually read — is a different component fed by two different
// server reads, and neither the reads nor the list knew the column existed.
// So 568 outcomes were saved and none were shown. Nothing failed, because
// nothing checked that what the form WRITES is something a screen DRAWS.
//
// So: the words live here, the picker imports them from here, and every list
// that draws a reach-out asks outcomeLabel(). A new list that forgets is one
// grep away from the others; lib/beta-touch-outcome-shown.test.tsx pins the
// lists and the server reads that exist today.
//
// touchpoints.status is NOT only an outcome. The same column carries
// 'sent' / 'failed' on drip emails, 'done' / 'pending' on system lines and
// notes, and 'pending' on 13 old "Follow-up · …" rows the close wizard wrote
// before reminders existed. None of those is the result of a call, so
// outcomeLabel answers null for anything that is not a reach-out carrying one
// of the three words below. No status → null → the row reads exactly as it
// did before (1,214 reach-outs have none).
// ─────────────────────────────────────────────────────────────

// value = what is stored; label = what people read. Order = the picker's.
export const OUTCOMES = [
  { value: 'reached', label: 'Reached' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'voicemail', label: 'Left voicemail' },
]

const LABEL_BY_VALUE = Object.fromEntries(OUTCOMES.map(o => [o.value, o.label]))

// touch: any touchpoint-shaped object ({ kind, status }). Rows that carry no
// kind at all are treated as reach-outs, so a caller holding a trimmed row
// still gets its outcome; a row that SAYS it is something else never does.
export function outcomeLabel(touch) {
  if (!touch) return null
  if (touch.kind && touch.kind !== 'reach_out') return null
  return LABEL_BY_VALUE[touch.status] || null
}

// "Call" → "Call · No answer". The one way a headline and its outcome join,
// so every list reads the same.
export function withOutcome(headline, touch) {
  const o = outcomeLabel(touch)
  return o ? `${headline} · ${o}` : headline
}
