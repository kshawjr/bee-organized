// lib/webhook-digest.ts
// ─────────────────────────────────────────────────────────────
// Pure formatter for the twice-daily Slack webhook-failure digest.
// The cron route (app/api/cron/webhook-digest) fetches the enriched
// events and posts whatever this returns — keeping the formatting
// pure keeps it unit-testable without Slack or Supabase.
//
// Policy: on a quiet window we still post a short "all clear" line
// (rather than skipping) so a silent digest is distinguishable from a
// dead digest — Kevin's lean, per the feature spec.
// ─────────────────────────────────────────────────────────────

import type { WebhookLogEvent } from './webhook-observability'

const MAX_LINES_PER_LOCATION = 8
const MAX_LOCATIONS = 10

export type WebhookDigest = {
  allClear: boolean
  failures: number
  stuck: number
  totalEvents: number
  text: string
}

export function buildWebhookDigest(opts: {
  events: WebhookLogEvent[]
  appUrl: string          // e.g. https://app.example.com (no trailing slash)
  windowLabel?: string    // human label for the query window
}): WebhookDigest {
  const { events, appUrl } = opts
  const windowLabel = opts.windowLabel || 'last 12h'
  const failures = events.filter(e => !e.processed)
  const stuck = events.filter(e => e.landed === 'stuck')

  if (failures.length === 0 && stuck.length === 0) {
    return {
      allClear: true,
      failures: 0,
      stuck: 0,
      totalEvents: events.length,
      text: `:white_check_mark: Webhooks all clear — ${events.length} event${events.length !== 1 ? 's' : ''} processed in the ${windowLabel}, 0 failures, 0 didn't land.`,
    }
  }

  // Group the problem rows by location, failures before didn't-land.
  const byLocation = new Map<string, { name: string; lines: string[] }>()
  const push = (e: WebhookLogEvent, line: string) => {
    const key = e.location_id || 'unknown'
    const entry = byLocation.get(key) || { name: e.location_name || key, lines: [] }
    entry.lines.push(line)
    byLocation.set(key, entry)
  }
  const who = (e: WebhookLogEvent) =>
    e.client_name || (e.jobber_item ? `Jobber #${e.jobber_item}` : 'Unknown record')
  for (const e of failures) {
    push(e, `• :x: ${who(e)} — ${e.friendly} (${e.topic}): ${e.error || 'unknown error'}`)
  }
  for (const e of stuck) {
    push(e, `• :warning: ${who(e)} — ${e.friendly} (${e.topic}): processed but didn't land`)
  }

  const sections: string[] = []
  const locations = Array.from(byLocation.values())
  for (const loc of locations.slice(0, MAX_LOCATIONS)) {
    const shown = loc.lines.slice(0, MAX_LINES_PER_LOCATION)
    const more = loc.lines.length - shown.length
    sections.push(
      `*${loc.name}*\n${shown.join('\n')}${more > 0 ? `\n_…plus ${more} more_` : ''}`,
    )
  }
  if (locations.length > MAX_LOCATIONS) {
    sections.push(`_…plus ${locations.length - MAX_LOCATIONS} more location(s)_`)
  }

  // Land on the dashboard pre-filtered to whichever bucket is non-empty
  // (failures win when both are).
  const filter = failures.length > 0 ? 'failures' : 'stuck'
  const link = `${appUrl}/admin?adminTab=webhooks&whFilter=${filter}&whWindow=24h`

  const header =
    `:rotating_light: *Webhook digest — ` +
    `${failures.length} failure${failures.length !== 1 ? 's' : ''}, ` +
    `${stuck.length} didn't land* (${windowLabel}, ${events.length} events total)`

  return {
    allClear: false,
    failures: failures.length,
    stuck: stuck.length,
    totalEvents: events.length,
    text: `${header}\n\n${sections.join('\n\n')}\n\n<${link}|Open the webhook dashboard>`,
  }
}
