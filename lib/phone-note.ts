// lib/phone-note.ts — keep what a phone field said when the formatter kept
// only the number.
//
// Kevin, 16 Oct 2026: a phone field holding two numbers keeps the FIRST as
// the phone, formatted, and "the whole original string goes into a note on
// that record so nothing is lost and the owner can sort it". The same goes
// for a number that came with words ("(daughter Jan)", "Office:") — the
// words are only ever kept here.
//
// The note is a 'note' touchpoint, so it shows on the record's activity
// timeline like any note an owner writes. Touchpoints hang off a lead or a
// Network person (partner) — the only records that have a timeline. Callers
// for every other table use formatPhone(), which never reduces such a field.

import { insertTouchpoint } from '@/lib/touchpoints'

export const PHONE_NOTE_LABEL = 'Phone tidied — original kept here'

export function phoneNoteText(original: string, kept: string): string {
  return `The phone field said: "${original.trim()}". It is now ${kept}. Anything else that was in it (a second number, a name) is only here.`
}

export async function recordPhoneNote(opts: {
  leadId?: string | null
  partnerId?: string | null
  locationUuid: string
  original: string
  kept: string
}): Promise<{ ok: boolean; error?: string }> {
  const res = await insertTouchpoint({
    lead_id: opts.leadId ?? null,
    partner_id: opts.leadId ? null : opts.partnerId ?? null,
    location_uuid: opts.locationUuid,
    kind: 'note',
    method: 'system',
    status: 'done',
    label: PHONE_NOTE_LABEL,
    notes: phoneNoteText(opts.original, opts.kept),
    user_id: null,
  })
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}
