// lib/slack-bot.ts
// ─────────────────────────────────────────────────────────────
// Per-location Slack BOT-token transport: posts a new-lead notification into a
// location's Slack channel via chat.postMessage, using the bot token minted by
// the "Add to Slack" OAuth install (app/api/slack/callback).
//
// SEPARATE from lib/slack.ts. That module is the OLD twice-daily failure DIGEST,
// which posts to a single global SLACK_WEBHOOK_URL (incoming webhook). This is a
// DIFFERENT mechanism entirely: per-location OAuth bot token → chat.postMessage
// into that location's own workspace + channel. They share zero env vars, zero
// columns, zero call paths. Do NOT merge them.
//
// Mirrors lib/jobber.ts's per-location read + never-throw-on-failure contract,
// but SKIPS all of Jobber's rotation/refresh/throttle machinery — Slack bot
// tokens do NOT rotate (rotation left OFF), so there is nothing to refresh, no
// expiry to track, no throttle budget to manage.
//
// SLACK QUIRK: a 200 HTTP status can still be a LOGICAL failure — Slack Web API
// responses carry { ok: false, error: "…" } in the JSON body. We check that,
// not just res.ok, and surface channel_not_found / not_in_channel / invalid_auth
// explicitly. Never throws — returns { ok, skipped?, error? } so the caller
// (intake) can swallow it and keep the email + lead row untouched.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'

const supabase = supabaseService

export const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage'

// The lead fields the notification renders — the same shape the email builder
// consumes (lib/lead-notification-email.ts NewLeadForNotification), so both
// channels carry identical information.
export type SlackLead = {
  id: string
  name: string
  email: string | null
  phone: string | null
  project_type: string | null
  request_details: string | null
  preferred_contact: string | null
}

export type SlackPostResult = { ok: boolean; skipped?: string; error?: string }

// ── Location read (service-role) ──────────────────────────────
// Mirrors lib/jobber.ts getLocation: reads the location row so postToSlack can
// resolve the bot token + channel itself, keeping the token server-side and out
// of every caller's payload. Returns null (never throws) on a miss so callers
// degrade to a quiet no-op.
async function getSlackLocation(locationId: string): Promise<{
  slack_connected: boolean | null
  slack_bot_token: string | null
  slack_channel_id: string | null
} | null> {
  const { data, error } = await supabase
    .from('locations')
    .select('slack_connected, slack_bot_token, slack_channel_id')
    .eq('id', locationId)
    .maybeSingle()
  if (error || !data) return null
  return data as any
}

// ── mrkdwn escaping ───────────────────────────────────────────
// Slack mrkdwn only needs &, <, > escaped (link/entity delimiters). Applied to
// every interpolated field so a stray "<" in a lead name can't break a link.
function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Captured field → value; blanks fall back to an em-dash, mirroring the email
// builder's dash() so a Slack post reads cleanly regardless of what the form
// collected.
const dash = (v: string | null | undefined): string =>
  v && v.trim() ? escapeMrkdwn(v.trim()) : '—'

// ── Pure message builder ──────────────────────────────────────
// Formats the new-lead Slack message in mrkdwn, INCLUDING the deep-link to the
// lead in Bee Hub (/clients/<id>) — the same link the email carries. Pure +
// testable (no Slack, no Supabase), mirroring buildLeadNotificationEmail and
// lib/webhook-digest.ts. Returns the chat.postMessage body sans `channel`
// (postToSlack fills that from the location row).
export function buildLeadSlackMessage(args: {
  lead: SlackLead
  locationName: string
  // Absolute Hub origin (no trailing slash) → `${baseUrl}/clients/${lead.id}`.
  // Null when no base URL is available — the link line is simply omitted.
  leadUrl: string | null
}): { text: string } {
  const { lead, locationName, leadUrl } = args
  const name = dash(lead.name)

  const lines: string[] = [
    `:bee: *New lead for ${escapeMrkdwn(locationName)}*`,
    '',
    `*Name:* ${name}`,
    `*Email:* ${dash(lead.email)}`,
    `*Phone:* ${dash(lead.phone)}`,
    `*Project type:* ${dash(lead.project_type)}`,
    `*Preferred contact:* ${dash(lead.preferred_contact)}`,
  ]

  if (lead.request_details?.trim()) {
    lines.push('', `*What they told us:*`, `>${escapeMrkdwn(lead.request_details.trim())}`)
  }

  if (leadUrl) {
    // mrkdwn link: <url|label>. escapeMrkdwn the URL too so a stray delimiter
    // can't break out of the link.
    lines.push('', `<${escapeMrkdwn(leadUrl)}|Open this lead in Bee Hub>`)
  }

  return { text: lines.join('\n') }
}

// ── Transport: chat.postMessage ───────────────────────────────
// Reads the location's bot token + channel, posts the message, and returns a
// non-throwing result. Quiet no-op (skipped) when Slack isn't connected /
// configured — a location without Slack is a normal state, exactly like an
// email location with zero recipients.
export async function postToSlack(
  locationId: string,
  message: { text: string },
): Promise<SlackPostResult> {
  const loc = await getSlackLocation(locationId)
  if (!loc) {
    return { ok: false, skipped: 'location_not_found' }
  }
  if (!loc.slack_connected || !loc.slack_bot_token || !loc.slack_channel_id) {
    return { ok: false, skipped: 'not_connected' }
  }

  try {
    const res = await fetch(SLACK_POST_MESSAGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${loc.slack_bot_token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: loc.slack_channel_id, ...message }),
      cache: 'no-store',
    })

    // A non-2xx HTTP status is a transport failure (rate-limit 429, 5xx, …).
    if (!res.ok) {
      console.error('[slack-bot] chat.postMessage HTTP', res.status, 'for', locationId)
      return { ok: false, error: `slack_http_${res.status}` }
    }

    // CRITICAL: HTTP 200 can still be a logical failure. Slack Web API puts the
    // real outcome in the JSON body's { ok, error }.
    const json = await res.json().catch(() => null as any)
    if (!json || json.ok !== true) {
      const err = json?.error || 'unknown_error'
      // channel_not_found / not_in_channel / invalid_auth are the actionable
      // ones (bad channel, bot not invited, uninstalled) — logged distinctly.
      console.error('[slack-bot] chat.postMessage not ok for', locationId, '—', err)
      return { ok: false, error: err }
    }

    return { ok: true }
  } catch (err: any) {
    console.error('[slack-bot] chat.postMessage threw for', locationId, '—', err?.message || err)
    return { ok: false, error: String(err?.message || err) }
  }
}

// ── Convenience: build + post in one call ─────────────────────
// What the intake route calls. Non-throwing end to end. baseUrl builds the
// /clients/<id> deep-link (same source the email uses); null just omits it.
export async function notifyNewLeadSlack(args: {
  locationId: string
  locationName: string | null
  lead: SlackLead
  baseUrl?: string | null
}): Promise<SlackPostResult> {
  const { locationId, lead, baseUrl } = args
  const locationName = args.locationName?.trim() || 'your location'
  const leadUrl = baseUrl ? `${baseUrl.replace(/\/$/, '')}/clients/${lead.id}` : null
  const message = buildLeadSlackMessage({ lead, locationName, leadUrl })
  return postToSlack(locationId, message)
}
