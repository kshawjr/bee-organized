// lib/other-card-sync.ts
// ─────────────────────────────────────────────────────────────
// Keeps Other's Slack route-suggestion cards in step with Bee Hub (Kevin,
// 20 Oct 2026). When a lead leaves Other by ANY route, its card is edited the
// way a button press edits it: the buttons go, and one line says what
// happened and who did it. If the lead later comes back into Other, the sweep
// posts a fresh card. So the channel never fills with cards whose buttons act
// on leads that are already handled.
//
//   recordOtherCard   — when Other's card posts (lib/slack-bot notifyNewLeadSlack)
//   retireOtherCards  — every exit, the moment it happens, naming the person:
//       routed            lib/lead-transfer.ts             "✅ Moved to Lincoln by …"
//       no-coverage sent  lib/lead-no-coverage.ts          "📭 Told … by …"
//       binned            PATCH /api/leads/:id (is_junk)   "🗑 Binned by …"
//       dismissed         PATCH (inbox_dismissed_at)       "📥 Dismissed by …"
//       snoozed           PATCH (snoozed_until ahead)      "💤 Snoozed until 25 Oct by …"
//       to the Network    /api/leads/:id/network (move)    "🤝 Moved to the Network by …"
//   markCardResolved  — a button press edited the card through Slack's own
//                       reply link; this records it
//   sweepOtherCards   — the backstop (/api/cron/other-cards): any card still
//                       live whose lead is no longer open in Other (by the same
//                       rule as the backlog script, lib/other-card-backlog
//                       resolvedReason — e.g. closed as not interested, an
//                       edit that failed), and a fresh card for any lead that
//                       came back.
//
// EVERYTHING HERE IS FAIL-SOFT. It never throws into the action that called
// it: a bin, a transfer or an email must never fail because Slack was slow.
// What it couldn't do, the sweep does next time.
//
// THE CARD'S WORDS ON AN EDIT are rebuilt from the lead (name, city/state/zip
// — lib/route-suggestion-slack) with the suggestion and buttons replaced by
// the line, exactly as a button press leaves it.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from '@/lib/supabase-service'
import { buildRouteSuggestionSlackMessage, buildResolvedRouteMessage } from '@/lib/route-suggestion-slack'
import { resolvedReason, OTHER_SLUG, type BacklogLead, type SkipReason } from '@/lib/other-card-backlog'

export const SLACK_UPDATE_URL = 'https://slack.com/api/chat.update'

export type CardResolution =
  | 'moved' | 'binned' | 'dismissed' | 'snoozed' | 'no_coverage' | 'network'
  | 'left_in_other' | 'archived' | 'has_engagement' | 'in_jobber' | 'gone'

// A card resolved this way leaves its lead open in Other on purpose (Leslie
// chose to route it in Bee Hub) — the sweep never reposts it.
const STAYS_RESOLVED: ReadonlySet<CardResolution> = new Set<CardResolution>(['left_in_other', 'moved', 'gone'])

// ── the words ─────────────────────────────────────────────────
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'America/New_York' })

export function exitLine(
  resolution: CardResolution,
  opts: { who?: string | null; dest?: string | null; until?: string | null; to?: string | null } = {},
): string {
  const by = opts.who ? ` by ${opts.who}` : ''
  switch (resolution) {
    case 'moved': return `✅ Moved to *${opts.dest || 'another location'}*${by}.`
    case 'binned': return `🗑 Binned${by}.`
    case 'dismissed': return `📥 Dismissed${by}.`
    case 'snoozed': return `💤 Snoozed${opts.until ? ` until ${shortDate(opts.until)}` : ''}${by}. Its card comes back when the snooze ends.`
    case 'no_coverage': return `📭 Told ${opts.to || 'them'} we don't serve their area yet (mailing-list link sent)${opts.who ? ` — by ${opts.who}` : ''}.`
    case 'network': return `🤝 Moved to the Network${by}.`
    case 'left_in_other': return `📥 Left in Other${by}. Route it in Bee Hub when ready.`
    case 'archived': return '🗄 Archived in Bee Hub.'
    case 'has_engagement': return '✔️ Closed in Bee Hub.'
    case 'in_jobber': return '✔️ Already in Jobber — handled in Bee Hub.'
    case 'gone': return '✔️ No longer in Other.'
  }
}

// The resolvedReason the sweep reads, as the card's resolution.
export function resolutionForReason(r: SkipReason): CardResolution {
  switch (r) {
    case 'binned': return 'binned'
    case 'dismissed': return 'dismissed'
    case 'snoozed': return 'snoozed'
    case 'no_coverage_sent': return 'no_coverage'
    case 'archived': return 'archived'
    case 'has_engagement': return 'has_engagement'
    case 'in_jobber': return 'in_jobber'
    default: return 'gone'
  }
}

export async function actorName(hubUserId: string | null | undefined): Promise<string | null> {
  if (!hubUserId) return null
  try {
    const { data } = await supabaseService.from('hub_users').select('full_name, first_name').eq('id', hubUserId).maybeSingle()
    return (data as any)?.full_name || (data as any)?.first_name || null
  } catch {
    return null
  }
}

// ── writes ────────────────────────────────────────────────────
export async function recordOtherCard(args: { leadId: string; locationUuid: string; channelId: string; messageTs: string }): Promise<void> {
  try {
    const { error } = await supabaseService.from('slack_cards').insert({
      lead_id: args.leadId,
      location_uuid: args.locationUuid,
      channel_id: args.channelId,
      message_ts: args.messageTs,
    })
    if (error) console.error('[other-card-sync] could not record card for lead', args.leadId, '—', error.message)
  } catch (err: any) {
    console.error('[other-card-sync] record threw —', err?.message || err)
  }
}

export async function markCardResolved(args: { channelId: string | undefined; messageTs: string | undefined; resolution: CardResolution; line: string }): Promise<void> {
  if (!args.channelId || !args.messageTs) return
  try {
    const { error } = await supabaseService
      .from('slack_cards')
      .update({ resolved_at: new Date().toISOString(), resolution: args.resolution, resolved_line: args.line })
      .eq('channel_id', args.channelId)
      .eq('message_ts', args.messageTs)
      .is('resolved_at', null)
    if (error) console.error('[other-card-sync] mark resolved failed —', error.message)
  } catch (err: any) {
    console.error('[other-card-sync] mark resolved threw —', err?.message || err)
  }
}

async function slackUpdate(token: string, channel: string, ts: string, message: { text: string; attachments: any[] }): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(SLACK_UPDATE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel, ts, ...message }),
      cache: 'no-store',
    })
    const json = await res.json().catch(() => null as any)
    return json?.ok === true ? { ok: true } : { ok: false, error: json?.error || `http_${res.status}` }
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) }
  }
}

// Edit every live card for this lead to `line`, buttons gone. Returns what it
// did; never throws.
export async function retireOtherCards(args: { leadId: string; resolution: CardResolution; line: string }): Promise<{ edited: number; failed: number }> {
  const out = { edited: 0, failed: 0 }
  try {
    const { data: cards, error } = await supabaseService
      .from('slack_cards')
      .select('id, location_uuid, channel_id, message_ts')
      .eq('lead_id', args.leadId)
      .is('resolved_at', null)
    if (error || !cards || (cards as any[]).length === 0) return out

    const { data: lead } = await supabaseService
      .from('leads')
      .select('id, name, city, state, zip')
      .eq('id', args.leadId)
      .maybeSingle()
    const cardLead: any = { id: args.leadId, name: (lead as any)?.name || '', email: null, phone: null, project_type: null, request_details: null, preferred_contact: null, city: (lead as any)?.city ?? null, state: (lead as any)?.state ?? null, zip: (lead as any)?.zip ?? null }
    const message = buildResolvedRouteMessage(buildRouteSuggestionSlackMessage({ lead: cardLead, suggestion: null, leadUrl: null }), args.line)

    const tokens = new Map<string, string | null>()
    for (const c of cards as any[]) {
      if (!tokens.has(c.location_uuid)) {
        const { data: loc } = await supabaseService.from('locations').select('slack_bot_token').eq('id', c.location_uuid).maybeSingle()
        tokens.set(c.location_uuid, (loc as any)?.slack_bot_token ?? null)
      }
      const token = tokens.get(c.location_uuid)
      if (!token) { out.failed++; continue }
      const res = await slackUpdate(token, c.channel_id, c.message_ts, message)
      if (!res.ok) {
        out.failed++
        console.error('[other-card-sync] chat.update failed for lead', args.leadId, '—', res.error)
        continue
      }
      await supabaseService
        .from('slack_cards')
        .update({ resolved_at: new Date().toISOString(), resolution: args.resolution, resolved_line: args.line })
        .eq('id', c.id)
      out.edited++
    }
  } catch (err: any) {
    console.error('[other-card-sync] retire threw —', err?.message || err)
  }
  return out
}

// ── the sweep ─────────────────────────────────────────────────
const JOBBER_FIELDS = ['jobber_client_id', 'jobber_request_id', 'jobber_quote_id', 'jobber_job_id', 'jobber_invoice_id', 'jobber_assessment_id', 'jobber_sync_status']

// The same facts the backlog script reads, so "open in Other" means one thing.
async function leadFacts(ids: string[]): Promise<Map<string, BacklogLead & { name: string | null }>> {
  const out = new Map<string, any>()
  if (!ids.length) return out
  const { data: leads, error } = await supabaseService
    .from('leads')
    .select(`id, name, first_name, last_name, location_id, is_junk, created_at, archived_at, inbox_dismissed_at, snoozed_until, ${JOBBER_FIELDS.join(', ')}`)
    .in('id', ids)
  if (error) throw new Error(`lead read failed: ${error.message}`)
  const [{ data: nc, error: ncErr }, { data: eg, error: egErr }] = await Promise.all([
    supabaseService.from('notification_log').select('lead_id').eq('email_kind', 'no_coverage_optin').eq('send_status', 'accepted').in('lead_id', ids),
    supabaseService.from('engagements').select('client_id').in('client_id', ids),
  ])
  if (ncErr || egErr) throw new Error(`facts read failed: ${(ncErr || egErr)!.message}`)
  const noCov = new Set(((nc as any[]) || []).map((r) => r.lead_id))
  const engaged = new Set(((eg as any[]) || []).map((r) => r.client_id))
  for (const l of (leads as any[]) || []) {
    out.set(l.id, { ...l, no_coverage_sent: noCov.has(l.id), has_engagement: engaged.has(l.id), in_jobber: JOBBER_FIELDS.some((f) => !!l[f]) })
  }
  return out
}

// Who moved a lead out of Other, from its transfer timeline entry.
async function movedBy(leadId: string): Promise<{ dest: string | null; who: string | null }> {
  const { data } = await supabaseService
    .from('touchpoints')
    .select('notes, user_id, occurred_at')
    .eq('lead_id', leadId)
    .eq('kind', 'system')
    .like('notes', 'Routed from%')
    .order('occurred_at', { ascending: false })
    .limit(1)
  const row = ((data as any[]) || [])[0]
  const dest = row?.notes ? String(row.notes).replace(/^Routed from .* to /, '') : null
  return { dest, who: await actorName(row?.user_id) }
}

// checked = how many leads with a card the sweep looked at.
export type SweepResult = { checked: number; retired: number; reposted: number; failed: number }

export async function sweepOtherCards(opts: { nowMs?: number; repost?: (lead: any) => Promise<boolean> } = {}): Promise<SweepResult> {
  const nowMs = opts.nowMs ?? Date.now()
  const result: SweepResult = { checked: 0, retired: 0, reposted: 0, failed: 0 }

  const { data: cards, error } = await supabaseService
    .from('slack_cards')
    .select('id, lead_id, posted_at, resolved_at, resolution')
    .order('posted_at', { ascending: true })
    .limit(1000)
  if (error || !cards) return result
  const byLead = new Map<string, any[]>()
  for (const c of cards as any[]) (byLead.get(c.lead_id) || byLead.set(c.lead_id, []).get(c.lead_id)!).push(c)

  const facts = await leadFacts(Array.from(byLead.keys()))
  result.checked = byLead.size

  for (const [leadId, list] of Array.from(byLead.entries())) {
    const lead = facts.get(leadId)
    const live = list.filter((c) => !c.resolved_at)
    const open = lead && lead.location_id === OTHER_SLUG && lead.is_junk !== true && !resolvedReason(lead, nowMs)

    // 1. A live card whose lead is no longer open in Other → edit it.
    if (live.length && !open) {
      let resolution: CardResolution
      let line: string
      if (!lead) { resolution = 'gone'; line = exitLine('gone') }
      else if (lead.location_id !== OTHER_SLUG) {
        const m = await movedBy(leadId)
        resolution = 'moved'; line = exitLine('moved', { dest: m.dest, who: m.who })
      } else if (lead.is_junk === true) { resolution = 'binned'; line = exitLine('binned') }
      else {
        const r = resolvedReason(lead, nowMs)!
        resolution = resolutionForReason(r)
        line = exitLine(resolution, { until: (lead as any).snoozed_until ?? null })
      }
      const done = await retireOtherCards({ leadId, resolution, line })
      result.retired += done.edited
      result.failed += done.failed
      continue
    }

    // 2. Every card resolved, the lead OPEN again (dismiss undone, restored,
    //    snooze over) → a fresh card. Never for "left in Other" or a move.
    if (!live.length && open && opts.repost) {
      const latest = list[list.length - 1]
      if (latest.resolution && !STAYS_RESOLVED.has(latest.resolution)) {
        if (await opts.repost(lead)) result.reposted++
        else result.failed++
      }
    }
  }
  return result
}
