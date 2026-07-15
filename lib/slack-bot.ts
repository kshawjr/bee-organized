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
  // Where the lead came from (leads.source). Human labels already ('Referral',
  // 'Instagram', …); the webform slug 'web_form' is humanized in the card.
  // Optional so the two callers that omit it typecheck + the line omits cleanly.
  source?: string | null
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

// Phone → tappable tel: mrkdwn link `<tel:+1XXXXXXXXXX|(formatted)>`. Digits
// only for the tel: target (E.164-ish: 10 digits → +1, 11 starting with 1 →
// +, anything else → +digits); the display keeps the human-formatted value.
// Blank → em-dash, matching dash().
const telLink = (phone: string | null | undefined): string => {
  if (!phone || !phone.trim()) return '—'
  const digits = phone.replace(/\D/g, '')
  if (!digits) return dash(phone)
  const e164 =
    digits.length === 10 ? `+1${digits}`
    : digits.length === 11 && digits.startsWith('1') ? `+${digits}`
    : `+${digits}`
  return `<tel:${e164}|${escapeMrkdwn(phone.trim())}>`
}

// Email → tappable mailto: mrkdwn link `<mailto:addr|addr>`. Blank → em-dash.
const mailtoLink = (email: string | null | undefined): string => {
  if (!email || !email.trim()) return '—'
  const e = escapeMrkdwn(email.trim())
  return `<mailto:${e}|${e}>`
}

// ── Card accents ──────────────────────────────────────────────
// The attachment `color` draws a left stripe on the whole card. Keyed by
// project type so a move visually reads different from an organizing job.
const TYPE_BLUE = '#2563eb' // moving / relocation
const TYPE_TEAL = '#0d9488' // organizing
const TYPE_GRAY = '#6b7280' // anything else / unknown / absent

// Distinct color by project type. Case-insensitive keyword match; organizing
// is checked BEFORE move so "Move-In/Out Organization" (organizing services)
// correctly read teal, while a pure "Moving" reads blue. Unmapped → gray.
export function projectTypeColor(type: string | null | undefined): string {
  const t = (type || '').toLowerCase()
  if (!t.trim()) return TYPE_GRAY
  if (t.includes('organiz')) return TYPE_TEAL
  if (t.includes('mov')) return TYPE_BLUE
  return TYPE_GRAY
}

// Source → human-friendly. leads.source is mostly already labels; the only
// slug in the wild is the webform's 'web_form'. null/blank → null (omit).
const humanizeSource = (s: string | null | undefined): string | null => {
  if (!s || !s.trim()) return null
  const v = s.trim()
  const low = v.toLowerCase()
  if (low === 'web_form' || low === 'webform' || low === 'website') return 'Website'
  // Slug (all-lower with separators) → Title Case; otherwise trust the label.
  if (v === low && /[_-]/.test(v)) {
    return v.split(/[_-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
  }
  return v
}

// ── Pure message builder ──────────────────────────────────────
// Formats the new-lead notification as a polished card: an `attachments`
// wrapper gives a color stripe (by project type) down the left edge, and the
// Block Kit body inside reads top-to-bottom — name, a "from <source>" meta
// line, a 2-column field grid (Phone / Email / Project / Preferred contact), an
// optional request-details quote, action buttons, and a footer. Each VALUE
// appears exactly ONCE: source lives only in the meta line, project only in the
// grid — no eyebrow badge, no Source grid cell (both were duplicates). Soft
// fields omit cleanly when absent, except Preferred contact which ALWAYS renders
// (— when empty): a name+phone-only lead still renders clean.
// Returns:
//   • text        — plain mrkdwn fallback (notification preview; UNCHANGED)
//   • attachments — [{ color, blocks }] — what Slack renders as the card
// Pure + testable (no Slack, no Supabase). postToSlack fills `channel`.
export function buildLeadSlackMessage(args: {
  lead: SlackLead
  locationName: string
  // Absolute Hub origin (no trailing slash) → `${baseUrl}/clients/${lead.id}`.
  // Null when no base URL is available — the Open button/link is omitted.
  leadUrl: string | null
}): { text: string; attachments: any[] } {
  const { lead, locationName, leadUrl } = args
  const name = dash(lead.name)

  // ── Top-level text = single-line summary (NOT the full detail) ─────────
  // The card lives in `attachments` (for the color stripe), and Slack renders a
  // non-empty top-level `text` as a VISIBLE body ABOVE the attachment. A rich
  // multi-line `text` therefore double-posted every field as a plain block over
  // the card. Keep the top-level `text` to a one-line summary so ONLY the card
  // renders; the card blocks below carry every detail. The same string is set as
  // the attachment `fallback` for non-block clients / notification previews.
  // Graceful: a missing lead name omits cleanly (no dangling ": ").
  const leadName = lead.name?.trim() ? escapeMrkdwn(lead.name.trim()) : ''
  const summary = leadName
    ? `🐝 New lead: ${leadName} (${escapeMrkdwn(locationName)})`
    : `🐝 New lead (${escapeMrkdwn(locationName)})`
  const text = summary

  // ── Resolved, display-ready soft fields (null = omit) ──────
  const projectLabel = lead.project_type?.trim() ? escapeMrkdwn(lead.project_type.trim()) : null
  const sourceRaw = humanizeSource(lead.source)
  const sourceLabel = sourceRaw ? escapeMrkdwn(sourceRaw) : null
  // Preferred contact ALWAYS renders in the grid — dash() gives the em-dash
  // fallback when empty (never omitted, unlike the other soft fields).
  const prefValue = dash(lead.preferred_contact)
  const hasPhone = !!lead.phone?.trim()
  const hasEmail = !!lead.email?.trim()

  const blocks: any[] = []

  // 2. Name — the prominent bold line, the card's first row (no eyebrow).
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${name}*` } })

  // 3. Source meta line — "from <source>" directly under the name; the ONLY
  //    place source appears. Omitted when source is absent.
  if (sourceLabel) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `from ${sourceLabel}` }] })
  }

  // 4. Fields — 2-column grid: Phone / Email / Project / Preferred contact.
  //    Phone/Email/Project omit when absent; Preferred contact ALWAYS shows
  //    (— when empty). Source is NOT here — it lives only in the meta line above.
  const fields: any[] = []
  if (hasPhone) fields.push({ type: 'mrkdwn', text: `*Phone:*\n${telLink(lead.phone)}` })
  if (hasEmail) fields.push({ type: 'mrkdwn', text: `*Email:*\n${mailtoLink(lead.email)}` })
  if (projectLabel) fields.push({ type: 'mrkdwn', text: `*Project:*\n${projectLabel}` })
  fields.push({ type: 'mrkdwn', text: `*Preferred contact:*\n${prefValue}` })
  blocks.push({ type: 'section', fields })

  // 5. What they told us — labeled quote, only when present.
  if (lead.request_details?.trim()) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*What they told us:*\n>${escapeMrkdwn(lead.request_details.trim())}` },
    })
  }

  // 6. Actions — Log call (primary/green) + optional Open in Bee Hub. The
  //    log_call action_id + value (lead id) are the interactivity contract —
  //    DO NOT change them.
  const elements: any[] = [
    {
      type: 'button',
      text: { type: 'plain_text', text: '📞 Log call', emoji: true },
      style: 'primary',
      action_id: 'log_call',
      value: lead.id,
    },
  ]
  if (leadUrl) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Open in Bee Hub', emoji: true },
      url: leadUrl,
    })
  }
  blocks.push({ type: 'actions', elements })

  // 7. Footer — location provenance (time omitted; the builder is pure).
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `${escapeMrkdwn(locationName)} · via Bee Hub` }],
  })

  // 8. Trailing divider so consecutive lead cards visually separate.
  blocks.push({ type: 'divider' })

  return { text, attachments: [{ color: projectTypeColor(lead.project_type), fallback: summary, blocks }] }
}

// ── Transport: chat.postMessage ───────────────────────────────
// Reads the location's bot token + channel, posts the message, and returns a
// non-throwing result. Quiet no-op (skipped) when Slack isn't connected /
// configured — a location without Slack is a normal state, exactly like an
// email location with zero recipients.
export async function postToSlack(
  locationId: string,
  message: { text: string; blocks?: any[]; attachments?: any[] },
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
      // unfurl_links/unfurl_media:false suppress Slack's auto-preview of the
      // "Open in Bee Hub" deep-link (the beehive.beeorganized.com site-preview
      // block that pushed the card past "Show more"). The button stays intact —
      // only the auto-generated preview is suppressed.
      body: JSON.stringify({
        channel: loc.slack_channel_id,
        unfurl_links: false,
        unfurl_media: false,
        ...message,
      }),
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

// ── users.info: Slack user id → email ─────────────────────────
// Resolves a clicking Slack user to their email so the interactivity handler
// can match a hub_user (we store no slack_user_id). Uses the location's bot
// token; needs the app's `users:read.email` scope. Never throws — returns null
// on any miss (no scope, no email set, API error) so the caller degrades to an
// unattributed touchpoint rather than failing the click.
export async function getSlackUserEmail(
  botToken: string,
  slackUserId: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`,
      { headers: { Authorization: `Bearer ${botToken}` }, cache: 'no-store' },
    )
    const json = await res.json().catch(() => null as any)
    if (!json || json.ok !== true) {
      console.error('[slack-bot] users.info not ok for', slackUserId, '—', json?.error || 'unknown')
      return null
    }
    const email = json.user?.profile?.email
    return typeof email === 'string' && email.trim() ? email.trim() : null
  } catch (err: any) {
    console.error('[slack-bot] users.info threw for', slackUserId, '—', err?.message || err)
    return null
  }
}
