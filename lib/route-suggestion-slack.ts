// lib/route-suggestion-slack.ts
// ─────────────────────────────────────────────────────────────
// The Slack card for a lead that lands in Other, and the edited card after a
// button is pressed (stage 4 of the route suggestion, 20 Oct 2026). Pure: no
// Slack calls, no database. lib/slack-bot.ts posts it; the interactivity
// route (lib/route-suggestion-actions.ts) edits it.
//
// THE CARD IS FOR DECIDING WHERE A LEAD GOES, NOT FOR WORKING IT (Kevin,
// 20 Oct 2026). It carries only:
//   • the lead's name
//   • where they are: city, state, zip (never the street)
//   • the suggestion from lib/route-suggestion.ts and its buttons —
//       up to three hive buttons, "Lincoln · 19 mi", the highlighted one green;
//       "Leave in Other", always;
//       "Not in our service area", only when the suggestion says so (a
//       measured nearest hive over 75 miles), red, with a confirm, because it
//       emails the customer
//   • Open in Bee Hub
// NO phone, email, project type, preferred contact, source or "What they told
// us": Leslie opens the lead if she needs them. The stripe is the neutral grey
// for the same reason — on a franchise card its colour IS the project type.
// No Log call button: a call is logged where the lead is worked.
//
// ONLY THE OTHER CARD. Franchise lead cards (lib/slack-bot
// buildLeadSlackMessage) keep every field; the owner works the lead from them.
// This builder deliberately does not reuse that one, so a field added there
// can never appear here by accident.
//
// THE ACTION CONTRACT. action_id route_accept_<n> (value {"lead","to"} as
// JSON, `to` the location slug), route_leave (value: lead id),
// route_no_coverage (value: lead id). The two suggestion blocks carry the
// block_ids below so an edit can find and replace them.
// ─────────────────────────────────────────────────────────────

import type { SlackLead } from '@/lib/slack-bot'
import type { RouteSuggestion } from '@/lib/route-suggestion'

export const ROUTE_ACCEPT_PREFIX = 'route_accept_'
export const ROUTE_LEAVE = 'route_leave'
export const ROUTE_NO_COVERAGE = 'route_no_coverage'
export const SUGGEST_BLOCK_ID = 'route_suggest'
export const ACTIONS_BLOCK_ID = 'route_actions'
export const DONE_BLOCK_ID = 'route_done'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function encodeAcceptValue(leadId: string, slug: string): string {
  return JSON.stringify({ lead: leadId, to: slug })
}

export function decodeAcceptValue(value: unknown): { lead: string; to: string } | null {
  if (typeof value !== 'string') return null
  try {
    const v = JSON.parse(value)
    return typeof v?.lead === 'string' && v.lead && typeof v?.to === 'string' && v.to ? { lead: v.lead, to: v.to } : null
  } catch {
    return null
  }
}

// The words above the buttons. Says what Bee Hub knows, never more.
export function suggestionHeadline(s: RouteSuggestion | null, rawZip: string | null): string {
  if (!s) return "📍 Bee Hub couldn't work out a suggestion just now. Route this lead in Bee Hub."
  const zip = s.zip ? `*${esc(s.zip)}*` : null
  switch (s.kind) {
    case 'claimed':
      return s.options.length === 1
        ? `📍 ${zip} is on *${esc(s.options[0].name)}*'s zip list.`
        : `📍 ${zip} is on ${s.options.length} zip lists: ${s.options.map((o) => `*${esc(o.name)}*`).join(' and ')}. Corporate hasn't settled which one covers it.`
    case 'nearby': {
      if (s.options.length === 0) return `📍 No hive that takes leads could be measured to from ${zip}. Route this lead in Bee Hub.`
      const lead = `📍 Closest hives to ${zip}:`
      if (s.noHighlightReason === 'near_tie') return `${lead}\n_The two closest are within a few miles of each other — pick one._`
      if (s.noHighlightReason === 'too_far') return `${lead}\n_The nearest hive is ${s.options[0].miles} mi away._`
      return lead
    }
    case 'no_zip':
      return "📍 This lead has no zip, so Bee Hub can't suggest a hive."
    case 'unreadable_zip':
      return `📍 The zip "${esc((rawZip || '').trim())}" isn't a US zip, so Bee Hub can't suggest a hive.`
    case 'unknown_zip':
      return `📍 ${zip} isn't in the Census zip list (often a PO box), so Bee Hub can't measure from it.`
  }
}

// Neutral grey — the franchise card's colour for "no project type".
export const OTHER_CARD_COLOR = '#6b7280'

// "Beatrice, NE 68310" from whatever was collected; null when nothing was.
// City, state and zip only — the street is a working detail.
export function placeLine(lead: Pick<SlackLead, 'city' | 'state' | 'zip'>): string | null {
  const city = (lead.city || '').trim()
  const state = (lead.state || '').trim()
  const zip = (lead.zip || '').trim()
  const tail = [state, zip].filter(Boolean).join(' ')
  const line = [city, tail].filter(Boolean).join(', ')
  return line || null
}

export function buildRouteSuggestionSlackMessage(args: {
  lead: SlackLead
  suggestion: RouteSuggestion | null
  leadUrl: string | null
}): { text: string; attachments: any[] } {
  const { lead, suggestion, leadUrl } = args

  const name = (lead.name || '').trim() || '—'
  const place = placeLine(lead)
  const headBlock = {
    type: 'section',
    text: { type: 'mrkdwn', text: `*${esc(name)}*\n${place ? esc(place) : '_No location given_'}` },
  }

  const lines = [suggestionHeadline(suggestion, lead.zip ?? null)]
  if (suggestion?.stateWarning) {
    lines.push(
      `⚠️ The lead says *${esc(suggestion.stateWarning.leadState)}*, but zip ${esc(suggestion.stateWarning.zip)} is somewhere else. ` +
        'One of them is a typo; the miles follow the zip.',
    )
  }
  const suggestBlock = { type: 'section', block_id: SUGGEST_BLOCK_ID, text: { type: 'mrkdwn', text: lines.join('\n') } }

  const elements: any[] = (suggestion?.options ?? []).map((o, i) => ({
    type: 'button',
    action_id: `${ROUTE_ACCEPT_PREFIX}${i}`,
    text: { type: 'plain_text', text: o.label, emoji: true },
    value: encodeAcceptValue(lead.id, o.slug),
    ...(o.highlighted ? { style: 'primary' } : {}),
  }))
  elements.push({
    type: 'button',
    action_id: ROUTE_LEAVE,
    text: { type: 'plain_text', text: 'Leave in Other', emoji: true },
    value: lead.id,
  })
  if (suggestion?.showNotInServiceArea) {
    elements.push({
      type: 'button',
      action_id: ROUTE_NO_COVERAGE,
      text: { type: 'plain_text', text: 'Not in our service area', emoji: true },
      style: 'danger',
      value: lead.id,
      confirm: {
        title: { type: 'plain_text', text: 'Not in our service area?' },
        text: {
          type: 'mrkdwn',
          text: `This emails ${esc(lead.name || 'the customer')} that we don't serve their area yet, with a mailing-list link, and takes the lead out of Other.`,
        },
        confirm: { type: 'plain_text', text: 'Send the email' },
        deny: { type: 'plain_text', text: 'Cancel' },
      },
    })
  }
  if (leadUrl) {
    elements.push({ type: 'button', text: { type: 'plain_text', text: 'Open in Bee Hub', emoji: true }, url: leadUrl })
  }
  const actionsBlock = { type: 'actions', block_id: ACTIONS_BLOCK_ID, elements }

  const blocks = [
    headBlock,
    suggestBlock,
    actionsBlock,
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Other · via Bee Hub' }] },
    { type: 'divider' },
  ]
  const text = '📍 New lead in Other — needs a hive'
  return { text, attachments: [{ color: OTHER_CARD_COLOR, fallback: text, blocks }] }
}

// The card after a button: the same lead details, the suggestion and its
// buttons replaced by one line saying what happened and who did it. Built
// from the message Slack sends back with the click, so it edits the card in
// place exactly as it was posted.
export function buildResolvedRouteMessage(original: { attachments?: any[]; text?: string } | null | undefined, line: string): { text: string; attachments: any[] } {
  const att = original?.attachments?.[0] ?? { blocks: [] }
  const kept = (att.blocks ?? []).filter((b: any) => b.block_id !== SUGGEST_BLOCK_ID && b.block_id !== ACTIONS_BLOCK_ID && b.block_id !== DONE_BLOCK_ID)
  const done = { type: 'context', block_id: DONE_BLOCK_ID, elements: [{ type: 'mrkdwn', text: line }] }
  // Above the trailing footer + divider, where the buttons were.
  const at = (() => {
    const idx = (att.blocks ?? []).findIndex((b: any) => b.block_id === ACTIONS_BLOCK_ID || b.block_id === DONE_BLOCK_ID)
    if (idx < 0) return kept.length
    return (att.blocks ?? []).slice(0, idx).filter((b: any) => b.block_id !== SUGGEST_BLOCK_ID && b.block_id !== DONE_BLOCK_ID).length
  })()
  kept.splice(at, 0, done)
  const text = original?.text || '📍 Lead in Other'
  return { text, attachments: [{ ...att, blocks: kept }] }
}
