// lib/job-channel-card.ts
// ─────────────────────────────────────────────────────────────
// THE JOB CARD: the first message in a job's Slack channel, pinned
// (2026-11-12). Written for a crew arriving at a house: where it is and who
// to ring come first.
//
//   *Client name* — Job type
//   *Address:* 6711 Calvert Commons Drive, Huntersville, NC, 28078   (a map link)
//   *Phone:* (303) 751-1112
//   *Email:* test@bmave.com
//   *Next assessment:* Fri, Nov 13 at 12:00 PM
//
//   *What they asked for:*
//   > the deal's description, when there is one
//
//   Open the job in Bee Hub
//   _Details as of Nov 12. Bee Hub has the latest._
//
// ONE CARD PER CHANNEL, BY CONSTRUCTION. It is posted from exactly one place:
// createJobChannel (lib/engagement-bees.ts), in the branch that has just made
// a new channel and won the write that remembers it. A channel that already
// exists returns before that branch; a reopened (unarchived) channel and a
// second job on the same deal never reach it. Nothing else posts a card, so
// nothing has to remember that one exists. lib/beta-job-channel-card.test.ts
// pins that postJobCard has that one caller.
//
// THE CARD IS NOT UPDATED LATER. It says what was true when the channel was
// made, and says so in its last line. Editing it afterwards would need its
// Slack message id stored on the deal (a new column) — not done here.
//
// THE PIN CAN BE REFUSED and must never cost anything. pins.add needs the
// pins:write permission, which a location only has after reconnecting once
// the app asks for it. The order is: post the card, then try to pin. Whatever
// Slack answers to the pin — missing_scope, a timeout, anything — the channel
// stands, the card stays posted as its first message, the people in it are
// untouched, and the caller is told `pinned: false` with Slack's own code.
// A refused pin is NOT recorded as a lost channel permission
// (recordSlackMissingScope): the location can still make channels.
//
// A card that cannot be fully filled in is still posted. Every read here is
// best effort: a missing address says so in words, a missing phone or email
// or assessment drops its line. The name, the job type and the link are
// handed in by the caller, which already has them.
//
// PUBLIC CHANNELS: this puts a client's home address and phone number where
// any member of that Slack workspace can read them. Kevin's decision.
//
// Logs ids and Slack codes only — no names, no addresses, no token.
// ─────────────────────────────────────────────────────────────
import { displayPhone } from '@/lib/phone'
import { requireIanaTimezone } from '@/lib/drip-time'
import { formatLeadAddress, normalizeAddressKey } from '@/lib/lead-address'

type Db = { from: (table: string) => any }
type SlackCall = (token: string, method: string, body: Record<string, unknown>) => Promise<any>

export const CARD_DESCRIPTION_MAX = 400
export const CARD_NO_ADDRESS = 'not on file yet. Check the job in Bee Hub before you go.'
export const cardNoStreet = (area: string) => `no street on file yet (${area}). Check the job in Bee Hub before you go.`

export type JobCardData = {
  clientName: string | null
  projectType: string | null
  address: string | null        // one line, already joined
  area?: string | null          // town / zip, when there is no street
  phone: string | null
  email: string | null
  nextAssessmentAt: string | null
  timezone: string | null       // IANA, or null when the location's is unknown
  description: string | null
  url: string | null
  asOf: string                  // ISO
}

// Slack reads & < > as markup; a pipe would end a link's label early.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const label = (s: string) => esc(s).replace(/\|/g, '/')
const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ') : null)

// The address as the rest of Bee Hub shows it (lib/lead-address.ts
// formatLeadAddress). That matters: on imported clients the `address` column
// already holds the WHOLE line — "6711 Calvert Commons Drive, Huntersville,
// NC, 28078" — with city, state and zip repeated in their own columns, and
// joining them again prints the town twice (seen on the real Test Location
// job, 2026-11-12). Null unless there is a street: a town alone is not
// somewhere a crew can go — `areaOnly` carries it for the "no street" line.
type AddressRow = { address?: unknown; street2?: unknown; city?: unknown; state?: unknown; zip?: unknown }
const str = (v: unknown) => (typeof v === 'string' ? v : null)
export function oneLineAddress(a: AddressRow | null | undefined): string | null {
  if (!clean(a?.address)) return null
  const line = formatLeadAddress({ address: clean(a?.address), city: clean(a?.city), state: clean(a?.state), zip: clean(a?.zip) })
  const unit = clean(a?.street2)
  return unit && !normalizeAddressKey(line).includes(normalizeAddressKey(unit)) ? `${line} (${unit})` : line
}
export function areaOnly(a: AddressRow | null | undefined): string | null {
  if (clean(a?.address)) return null
  return clean(formatLeadAddress({ address: null, city: str(a?.city), state: str(a?.state), zip: str(a?.zip) }))
}

const when = (iso: string, tz: string, withTime: boolean) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  try {
    const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(d)
    if (!withTime) return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(d)
    const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d)
    return `${day} at ${time}`
  } catch {
    return null
  }
}

// ── The text, exactly as Slack is sent it ────────────────────
export function jobCardText(d: JobCardData): string {
  const lines: string[] = []
  lines.push(`*${esc(d.clientName || 'this client')}*${d.projectType ? ` — ${esc(d.projectType)}` : ''}`)

  if (d.address) {
    lines.push(`*Address:* <https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.address)}|${label(d.address)}>`)
  } else {
    lines.push(`*Address:* ${d.area ? cardNoStreet(esc(d.area)) : CARD_NO_ADDRESS}`)
  }
  if (d.phone) lines.push(`*Phone:* ${esc(d.phone)}`)
  if (d.email) lines.push(`*Email:* ${esc(d.email)}`)
  // A time is only shown when the location's time zone is known: a wrong
  // hour on a card about turning up at someone's house is worse than none.
  const assessment = d.nextAssessmentAt && d.timezone ? when(d.nextAssessmentAt, d.timezone, true) : null
  if (assessment) lines.push(`*Next assessment:* ${assessment}`)

  if (d.description) {
    const text = d.description.length > CARD_DESCRIPTION_MAX ? `${d.description.slice(0, CARD_DESCRIPTION_MAX).trimEnd()}…` : d.description
    lines.push('', '*What they asked for:*', ...text.split(/\r?\n/).map(l => `> ${esc(l)}`))
  }

  lines.push('')
  if (d.url) lines.push(`<${d.url}|Open the job in Bee Hub>`)
  const asOf = d.timezone ? when(d.asOf, d.timezone, false) : null
  lines.push(asOf ? `_Details as of ${asOf}. Bee Hub has the latest._` : '_Details as of when this channel was made. Bee Hub has the latest._')
  return lines.join('\n')
}

// ── What goes on it, read from what Bee Hub already holds ────
// Never throws. Each read stands alone: one that fails drops its lines.
export async function readJobCardData(
  db: Db,
  args: { engagementId: string; locationUuid: string; clientId: string | null; clientName: string | null; projectType: string | null; url: string | null; now?: Date },
): Promise<JobCardData> {
  const now = args.now ?? new Date()
  const d: JobCardData = {
    clientName: args.clientName, projectType: args.projectType, address: null, area: null, phone: null, email: null,
    nextAssessmentAt: null, timezone: null, description: null, url: args.url, asOf: now.toISOString(),
  }
  const soft = async (what: string, fn: () => Promise<void>) => {
    try { await fn() } catch (e: any) { console.warn(`[job-channel-card] ${what} not read engagement=${args.engagementId} —`, e?.name || 'error') }
  }
  await soft('client', async () => {
    if (!args.clientId) return
    const { data, error } = await db.from('leads').select('address, street2, city, state, zip, phone, email').eq('id', args.clientId).maybeSingle()
    if (error || !data) return
    d.address = oneLineAddress(data)
    d.area = areaOnly(data)
    d.phone = clean(displayPhone(data.phone))
    d.email = clean(data.email)
  })
  await soft('description', async () => {
    const { data, error } = await db.from('engagements').select('description').eq('id', args.engagementId).maybeSingle()
    if (error || !data) return
    d.description = typeof data.description === 'string' && data.description.trim() ? data.description.trim() : null
  })
  await soft('time zone', async () => {
    const { data, error } = await db.from('locations').select('timezone').eq('id', args.locationUuid).maybeSingle()
    if (error || !data) return
    try { d.timezone = requireIanaTimezone(data.timezone) } catch { d.timezone = null }
  })
  await soft('assessment', async () => {
    const { data, error } = await db.from('assessments').select('scheduled_at, status')
      .eq('engagement_id', args.engagementId).eq('status', 'scheduled').gte('scheduled_at', now.toISOString())
      .order('scheduled_at', { ascending: true }).limit(1)
    if (error || !Array.isArray(data) || !data[0]?.scheduled_at) return
    d.nextAssessmentAt = String(data[0].scheduled_at)
  })
  return d
}

// ── Post it, then try to pin it ──────────────────────────────
export type CardResult = { posted: boolean; pinned: boolean; postError?: string; pinError?: string }

const code = (j: any) => (typeof j?.error === 'string' ? j.error.slice(0, 60) : 'unknown')

export async function postJobCard(
  db: Db,
  args: {
    slackApi: SlackCall; token: string; channelId: string
    engagementId: string; locationUuid: string; clientId: string | null
    clientName: string | null; projectType: string | null; url: string | null
  },
): Promise<CardResult> {
  let posted_ = false
  try {
    const data = await readJobCardData(db, args)
    const posted = await args.slackApi(args.token, 'chat.postMessage', {
      channel: args.channelId, text: jobCardText(data), unfurl_links: false, unfurl_media: false,
    })
    if (!posted?.ok) {
      console.warn(`[job-channel-card] card not posted engagement=${args.engagementId} → ${code(posted)}`)
      return { posted: false, pinned: false, postError: code(posted) }
    }
    posted_ = true
    const ts = typeof posted.ts === 'string' && posted.ts ? posted.ts : null
    if (!ts) {
      console.warn(`[job-channel-card] card posted, no message id to pin engagement=${args.engagementId}`)
      return { posted: true, pinned: false, pinError: 'no_message_id' }
    }
    const pin = await args.slackApi(args.token, 'pins.add', { channel: args.channelId, timestamp: ts })
    if (pin?.ok || pin?.error === 'already_pinned') return { posted: true, pinned: true }
    // Refused. The channel and the card stand; nothing is undone and the
    // location's channel permission is NOT marked lost.
    console.warn(`[job-channel-card] card posted, not pinned engagement=${args.engagementId} → ${code(pin)}`)
    return { posted: true, pinned: false, pinError: code(pin) }
  } catch (e: any) {
    console.warn(`[job-channel-card] card threw engagement=${args.engagementId} —`, e?.name || 'error')
    // If the card was already up when it threw, say so: it is still there.
    return posted_ ? { posted: true, pinned: false, pinError: 'threw' } : { posted: false, pinned: false, postError: 'threw' }
  }
}
