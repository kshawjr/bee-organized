// lib/network/history.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 1 — a contact's timeline. Pure.
// Ported from the design's contact-history.ts, on Kevin's types, levels and
// stages (lib/network/types.ts).
//
// changeEvents() says in plain words what changed between two versions of a
// contact; contactHistory() lays the whole timeline out for the History tab.
// ─────────────────────────────────────────────────────────────

import {
  LEVEL_META, contactTypes, money, partnerLevel, partnerStage,
  type HistoryEvent, type NetContact,
} from './types'

const plural = (n: number) => (n > 1 ? 's' : '')

/** Describe what changed between two versions of a contact. */
export function changeEvents(prev: NetContact, next: NetContact, when = 'Today'): HistoryEvent[] {
  const out: HistoryEvent[] = []
  const added = next.tags.filter((t) => !prev.tags.includes(t))
  const removed = prev.tags.filter((t) => !next.tags.includes(t))
  if (added.length) out.push({ kind: 'tags', when, text: `Added tag${plural(added.length)} ${added.join(', ')}` })
  if (removed.length) out.push({ kind: 'tags', when, text: `Removed tag${plural(removed.length)} ${removed.join(', ')}` })

  if (contactTypes(prev).join() !== contactTypes(next).join()) out.push({ kind: 'type', when, text: 'Changed contact type' })

  // Level and stage are read through the helpers, so a contact who is not a
  // Referral partner never reports one, whatever is stored on it.
  const level = partnerLevel(next)
  if (partnerLevel(prev) !== level) {
    out.push({ kind: 'partner', when, text: level ? `Level set to ${LEVEL_META[level].label}` : 'Partner level cleared' })
  }
  const stage = partnerStage(next)
  if (partnerStage(prev) !== stage && stage) out.push({ kind: 'partner', when, text: `Moved to ${stage}` })

  if (prev.workflow !== next.workflow) out.push({ kind: 'email', when, text: next.workflow ? `Started workflow “${next.workflow}”` : 'Stopped workflow' })
  if (prev.drip !== next.drip) out.push({ kind: 'email', when, text: next.drip ? `Enrolled in drip “${next.drip}”` : 'Removed from drip' })
  if (prev.mailchimp.on !== next.mailchimp.on) out.push({ kind: 'email', when, text: next.mailchimp.on ? 'Added to Mailchimp' : 'Removed from Mailchimp' })
  if (prev.nextFollowUp !== next.nextFollowUp) out.push({ kind: 'followup', when, text: next.nextFollowUp ? `Follow-up set for ${next.nextFollowUp}` : 'Follow-up cleared' })
  if (prev.phone !== next.phone) out.push({ kind: 'created', when, text: next.phone ? 'Updated phone number' : 'Removed phone number' })
  if (prev.email !== next.email) out.push({ kind: 'created', when, text: next.email ? 'Updated email address' : 'Removed email address' })
  if (prev.howMet !== next.howMet) out.push({ kind: 'created', when, text: next.howMet ? 'Updated how you met' : 'Cleared how you met' })
  if (prev.birthday !== next.birthday) out.push({ kind: 'followup', when, text: next.birthday ? `Birthday set for ${next.birthday}` : 'Birthday cleared' })
  if (Boolean(prev.birthdayReminder) !== Boolean(next.birthdayReminder)) out.push({ kind: 'followup', when, text: next.birthdayReminder ? 'Marked for birthday reminder' : 'Birthday reminder removed' })
  return out
}

/** Full timeline: notes, recorded changes, touchpoints, and a referral summary. */
export function contactHistory(c: NetContact): HistoryEvent[] {
  const notes: HistoryEvent[] = (c.notes ?? []).map((n) => ({ kind: 'note', when: n.at, text: n.title ? `${n.title}: ${n.text}` : n.text }))
  const events: HistoryEvent[] = [...notes, ...(c.history ?? [])]
  for (const t of c.touchpoints ?? []) events.push({ kind: 'touchpoint', when: t.when, text: `${t.kind}${t.note ? ` — ${t.note}` : ''}` })
  if (c.referred > 0) {
    events.push({
      kind: 'referral',
      when: 'All time',
      text: `Sent ${c.referred} referral${plural(c.referred)}, ${c.converted} became jobs${c.revenue ? ` (${money(c.revenue)})` : ''}`,
    })
  }
  if (c.howMet) events.push({ kind: 'created', when: 'Start', text: `How you met: ${c.howMet}` })
  return events
}
