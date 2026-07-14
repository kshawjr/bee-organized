// lib/touchpoints.ts
// ─────────────────────────────────────────────────────────────
// THE single touchpoint insert. Extracted from POST /api/touchpoints so the
// in-record logging path AND the Slack "Log call" interactivity handler share
// ONE writer — a Slack-logged call is byte-identical to one logged inside the
// record (same table, same columns, same reach_out side-effect). Never throws:
// returns { ok, ... } so fail-soft callers (Slack) can swallow it.
//
// Auth/validation/scoping stay in the route (it has the session); this module
// is only the resolved insert + the reach_out updated_at bump.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'

export type TouchpointRow = {
  lead_id: string
  location_uuid: string
  kind: string
  label: string
  method?: string | null
  status?: string | null
  drip_id?: string | null
  notes?: string | null
  engagement_id?: string | null
  // The acting hub_user, already resolved by the caller. null = system /
  // unattributed (the route sets this for kind system|drip; the Slack handler
  // sets it when the clicker isn't a known hub_user).
  user_id?: string | null
  occurred_at?: string | null
}

export type InsertTouchpointResult =
  | { ok: true; touchpoint: any }
  | { ok: false; error: string }

// Insert a touchpoint row exactly as POST /api/touchpoints does, then run the
// reach_out side-effect (bump leads.updated_at). engagement_id is omitted from
// the payload entirely when absent — matching the route's conditional spread,
// so a client-level touchpoint behaves exactly as before.
export async function insertTouchpoint(row: TouchpointRow): Promise<InsertTouchpointResult> {
  const insertRow: Record<string, unknown> = {
    lead_id: row.lead_id,
    location_uuid: row.location_uuid,
    kind: row.kind,
    ...(typeof row.engagement_id === 'string' && row.engagement_id
      ? { engagement_id: row.engagement_id }
      : {}),
    label: row.label.trim(),
    method: row.method ?? null,
    status: row.status ?? null,
    drip_id: row.drip_id ?? null,
    notes: row.notes ?? null,
    user_id: row.user_id ?? null,
  }
  if (row.occurred_at) insertRow.occurred_at = row.occurred_at

  const { data, error } = await supabaseService
    .from('touchpoints')
    .insert(insertRow)
    .select('*')
    .single()
  if (error) return { ok: false, error: error.message }

  // Reach-out side effect: bump lead's updated_at (mirrors the route 1:1).
  if (row.kind === 'reach_out') {
    await supabaseService
      .from('leads')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', row.lead_id)
  }

  return { ok: true, touchpoint: data }
}

// The canonical "Log call" quick action — matches InboxScreen.jsx's logCall
// 1:1 (kind='reach_out', method='call', label='Reach-out', lead-level). The
// Slack button reuses THIS so the logged call is indistinguishable from an
// in-record one. userId null → unattributed (clicker not a known hub_user).
export async function logCallTouchpoint(args: {
  leadId: string
  locationUuid: string
  userId?: string | null
  engagementId?: string | null
}): Promise<InsertTouchpointResult> {
  return insertTouchpoint({
    lead_id: args.leadId,
    location_uuid: args.locationUuid,
    kind: 'reach_out',
    method: 'call',
    label: 'Reach-out',
    user_id: args.userId ?? null,
    engagement_id: args.engagementId ?? null,
  })
}
