// lib/route-suggestion-actions.ts
// ─────────────────────────────────────────────────────────────
// What happens when someone presses a button on Other's route-suggestion card
// (stage 4, 20 Oct 2026). app/api/slack/interactivity has already checked
// Slack's signature; this decides who pressed it and does the one thing.
//
// WHO MAY PRESS. Only corporate (isAdmin). The clicker's Slack email (looked
// up with Other's own bot token — the card lives in Other's workspace) must
// match a Bee Hub user whose role is admin or super_admin. Anyone else gets a
// private "only corporate can route leads" reply and NOTHING is written. This
// is stricter than Log call, which accepts an unknown clicker: a transfer
// moves a customer between franchises and emails them, so it is never
// unattributed. transferLead / closeLeadAsNoCoverage check the role again.
//
// THE BUTTONS
//   route_accept_<n>  → transferLead to that hive. The card is EDITED IN PLACE
//                       to "Moved to Lincoln by Leslie Mullins".
//   route_leave       → nothing written; the card is edited to "Left in Other
//                       by …" so the channel shows it was seen.
//   route_no_coverage → closeLeadAsNoCoverage, which runs the served-area
//                       check every door shares (lib/no-coverage-guard): a
//                       claimed zip is refused, within 75 measured miles needs
//                       a person to confirm in Bee Hub, past 75 it sends and
//                       the card is edited.
// A lead no longer in Other (moved in Bee Hub, or a second click) edits the
// card to say where it is and changes nothing. A refused move (in Jobber, has
// an engagement, no email) leaves the card as it is and tells the clicker why,
// privately.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { getSlackUserEmail } from '@/lib/slack-bot'
import { transferLead, type TransferActor } from '@/lib/lead-transfer'
import { closeLeadAsNoCoverage } from '@/lib/lead-no-coverage'
import { ZIP_FALLBACK_SLUG } from '@/lib/zip-routing'
import { markCardResolved } from '@/lib/other-card-sync'
import {
  ROUTE_ACCEPT_PREFIX,
  ROUTE_LEAVE,
  ROUTE_NO_COVERAGE,
  decodeAcceptValue,
  buildResolvedRouteMessage,
} from '@/lib/route-suggestion-slack'

export const isRouteAction = (actionId: unknown): boolean =>
  typeof actionId === 'string' &&
  (actionId.startsWith(ROUTE_ACCEPT_PREFIX) || actionId === ROUTE_LEAVE || actionId === ROUTE_NO_COVERAGE)

export type RouteActionInput = {
  actionId: string
  value: unknown
  slackUserId: string | undefined
  responseUrl: string | undefined
  // The card as Slack sends it back with the click — edited in place.
  message: { text?: string; attachments?: any[] } | undefined
  // Which message was pressed, so the press is recorded on its slack_cards
  // row (lib/other-card-sync markCardResolved). Optional: old cards have none.
  channelId?: string
  messageTs?: string
}

// What the handler did, for the logs and the tests.
export type RouteActionOutcome =
  | 'refused_not_corporate'
  | 'refused_bad_value'
  | 'already_moved'
  | 'moved'
  | 'move_refused'
  | 'left_in_other'
  | 'no_coverage_sent'
  | 'no_coverage_refused'
  | 'no_coverage_blocked'
  | 'no_coverage_needs_confirmation'
  | 'lead_not_found'
  | 'destination_not_found'

async function reply(responseUrl: string | undefined, body: Record<string, any>): Promise<void> {
  if (!responseUrl) return
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
  } catch (err: any) {
    console.error('[route-actions] response_url post failed —', err?.message || err)
  }
}
const privately = (url: string | undefined, text: string) =>
  reply(url, { response_type: 'ephemeral', replace_original: false, text })
const editCard = (url: string | undefined, message: RouteActionInput['message'], line: string) =>
  reply(url, { replace_original: true, ...buildResolvedRouteMessage(message, line) })

// A refusal's reason, ready to sit mid-sentence: "This lead is in Jobber." → "This lead is in Jobber".
const reasonOf = (body: Record<string, any>) => String(body.detail || body.error || 'unknown error').trim().replace(/\.+$/, '')

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`)

// Slack user → the corporate Bee Hub user, or null. Never throws.
export async function resolveCorporateClicker(slackUserId: string | undefined): Promise<(TransferActor & { name: string }) | null> {
  if (!slackUserId) return null
  try {
    const { data: other } = await supabaseService
      .from('locations')
      .select('slack_bot_token')
      .eq('location_id', ZIP_FALLBACK_SLUG)
      .maybeSingle()
    if (!other?.slack_bot_token) return null
    const email = ((await getSlackUserEmail(other.slack_bot_token, slackUserId)) || '').trim().toLowerCase()
    if (!email) return null
    const { data: candidates } = await supabaseService
      .from('hub_users')
      .select('id, role, full_name, first_name, email, disabled_at')
      .ilike('email', escapeLike(email))
      .limit(10)
    const matches = ((candidates as any[]) || []).filter(
      (c) => (c.email || '').trim().toLowerCase() === email && !c.disabled_at,
    )
    // Two rows on one email is common for an admin; take the corporate one.
    const hu = matches.find((c) => isAdmin(c.role))
    if (!hu) return null
    return { hubUserId: hu.id, role: hu.role, name: hu.full_name || hu.first_name || email }
  } catch (err: any) {
    console.error('[route-actions] clicker resolve failed —', err?.message || err)
    return null
  }
}

async function locationNameBySlug(slug: string | null): Promise<string> {
  if (!slug) return 'another location'
  const { data } = await supabaseService.from('locations').select('name').eq('location_id', slug).maybeSingle()
  return data?.name || slug
}

export async function handleRouteAction(input: RouteActionInput): Promise<RouteActionOutcome> {
  const { actionId, value, slackUserId, responseUrl, message, channelId, messageTs } = input

  const accept = actionId.startsWith(ROUTE_ACCEPT_PREFIX) ? decodeAcceptValue(value) : null
  const leadId = accept ? accept.lead : typeof value === 'string' && value ? value : null
  if (!leadId || (actionId.startsWith(ROUTE_ACCEPT_PREFIX) && !accept)) {
    await privately(responseUrl, ":warning: That button didn't carry a lead Bee Hub can read. Route this lead in Bee Hub.")
    return 'refused_bad_value'
  }

  // ── Who pressed it — corporate only, before anything is read or written ──
  const actor = await resolveCorporateClicker(slackUserId)
  if (!actor) {
    await privately(
      responseUrl,
      ":no_entry: Only corporate can route leads from Slack, and your Slack email isn't a corporate Bee Hub user. Nothing was changed.",
    )
    return 'refused_not_corporate'
  }

  // ── Is the lead still in Other? ──────────────────────────────
  const { data: lead } = await supabaseService
    .from('leads')
    .select('id, name, location_id')
    .eq('id', leadId)
    .maybeSingle()
  if (!lead) {
    await privately(responseUrl, ':warning: Bee Hub could not find that lead. Nothing was changed.')
    return 'lead_not_found'
  }
  if (lead.location_id !== ZIP_FALLBACK_SLUG) {
    const where = await locationNameBySlug(lead.location_id)
    const line = `↪️ Already moved to *${where}* — nothing changed. (Pressed by ${actor.name})`
    await editCard(responseUrl, message, line)
    await markCardResolved({ channelId, messageTs, resolution: 'moved', line })
    return 'already_moved'
  }

  // ── Leave in Other ───────────────────────────────────────────
  if (actionId === ROUTE_LEAVE) {
    const line = `📥 Left in Other by ${actor.name}. Route it in Bee Hub when ready.`
    await editCard(responseUrl, message, line)
    await markCardResolved({ channelId, messageTs, resolution: 'left_in_other', line })
    return 'left_in_other'
  }

  // ── Not in our service area ──────────────────────────────────
  // ONE rule for every door (lib/no-coverage-guard, run inside
  // closeLeadAsNoCoverage): a zip on a location's list is refused, and a hive
  // within 75 measured miles — or a customer Bee Hub can't place — needs a
  // person's confirmation with the number in front of them. Slack can't show
  // that, so it never confirms: the card only offers this button past 75
  // measured miles, and anything else is sent to Bee Hub's Inbox to decide.
  if (actionId === ROUTE_NO_COVERAGE) {
    const out = await closeLeadAsNoCoverage({ leadId, actor, requestOrigin: null, confirmedOutOfRange: false })
    if (out.status === 409 && out.body.error === 'zip_claimed') {
      await privately(responseUrl, `:no_entry: ${out.body.detail} Nothing was sent.`)
      return 'no_coverage_blocked'
    }
    if (out.status === 409 && out.body.error === 'needs_confirmation') {
      await privately(responseUrl, `:warning: ${out.body.detail} That needs a person to confirm in Bee Hub (Inbox → No coverage). Nothing was sent.`)
      return 'no_coverage_needs_confirmation'
    }
    if (out.status !== 200) {
      await privately(responseUrl, `:warning: The not-in-area email didn't go: ${reasonOf(out.body)}. The lead is still in Other.`)
      return 'no_coverage_refused'
    }
    await editCard(responseUrl, message, `📭 Told ${out.body.to} we don't serve their area yet (mailing-list link sent) — by ${actor.name}.`)
    return 'no_coverage_sent'
  }

  // ── Accept: move it ──────────────────────────────────────────
  const { data: dest } = await supabaseService
    .from('locations')
    .select('id, name, location_id')
    .eq('location_id', accept!.to)
    .maybeSingle()
  if (!dest) {
    await privately(responseUrl, `:warning: Bee Hub has no location "${accept!.to}" any more. Nothing was changed.`)
    return 'destination_not_found'
  }
  const out = await transferLead({ leadId, destinationLocationId: dest.id, reason: null, actor, requestOrigin: null })
  if (out.status !== 200) {
    await privately(responseUrl, `:warning: Couldn't move this lead to ${dest.name}: ${reasonOf(out.body)}. It is still in Other.`)
    return 'move_refused'
  }
  // Already a client there: the enquiry went onto their record and this copy
  // was binned (lib/lead-transfer attachToExistingClient) — say that, not "moved".
  await editCard(responseUrl, message, out.body.attached_to
    ? `🔁 Already a client at *${dest.name}* — added to their record by ${actor.name}.`
    : `✅ Moved to *${dest.name}* by ${actor.name}.`)
  return 'moved'
}
