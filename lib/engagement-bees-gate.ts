// lib/engagement-bees-gate.ts
// The door both job-bee routes share: a logged-in hub user, the engagement
// loaded (with or without the channel columns), and the same location rule
// the assignees route uses — super_admin/admin any location, everyone else
// only their own (hub_users.location_id === engagement.location_uuid).
import { NextResponse } from 'next/server'
import { requireAuth, getHubUser, isAdmin } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import { loadEngagementForBees, type EngagementForBees } from '@/lib/engagement-bees'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (s: unknown) => typeof s === 'string' && UUID_RE.test(s)

export async function gateEngagement(id: string): Promise<
  | { res: NextResponse }
  | { res?: undefined; hubUser: any; eng: EngagementForBees }
> {
  await requireAuth()
  const hubUser = await getHubUser()
  if (!hubUser) return { res: NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 }) }
  if (!isUuid(id)) return { res: NextResponse.json({ error: 'invalid_id' }, { status: 400 }) }
  const eng = await loadEngagementForBees(supabaseService, id)
  if (!eng) return { res: NextResponse.json({ error: 'engagement_not_found' }, { status: 404 }) }
  if (!isAdmin(hubUser.role) && hubUser.location_id !== eng.location_uuid) {
    return { res: NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 }) }
  }
  return { hubUser, eng }
}

// Who can actually reconnect this location's Slack — the rule
// lib/slack-oauth-guard authorizeSlackConnect enforces: super_admin / admin,
// or the OWNER of this location. A manager or a read-only user has no Slack
// settings to go to, so the panel never tells them to reconnect.
export function canReconnectSlack(hubUser: { role?: string | null; location_id?: string | null } | null | undefined, locationUuid: string): boolean {
  if (!hubUser) return false
  const role = String(hubUser.role || '')
  if (role === 'super_admin' || role === 'admin') return true
  return role === 'owner' && hubUser.location_id === locationUuid
}

// What the browser is told about the job's channel. Built field by field.
export function publicChannel(eng: EngagementForBees) {
  if (!eng.slack_channel_id) return null
  return { id: eng.slack_channel_id, name: eng.slack_channel_name || null, archived: !!eng.slack_channel_archived_at }
}
