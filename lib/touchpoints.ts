// lib/touchpoints.ts
// ─────────────────────────────────────────────────────────────
// THE single touchpoint insert. Extracted from POST /api/touchpoints so the
// in-record logging path AND the Slack "Log call" interactivity handler share
// ONE writer — a Slack-logged call is byte-identical to one logged inside the
// record (same table, same columns, same reach_out side-effect). Never throws:
// returns { ok, ... } so fail-soft callers (Slack) can swallow it.
//
// NETWORK PHASE 1: the subject is now lead XOR partner (exactly one). The
// lead path is BYTE-IDENTICAL to before — a lead insert never carries a
// partner_id key at all (not even null), so it works unchanged before AND
// after migrations/network_phase1.sql. The partner path requires that
// migration (touchpoints.partner_id + the XOR CHECK); before it's applied a
// partner insert fails loudly at the DB ({ ok:false }), never silently.
//
// Side-effects stay subject-symmetric:
//   lead    reach_out → bump leads.updated_at            (unchanged)
//   partner reach_out → bump partners.last_contacted_at  (the stored cache
//     network_phase1.sql §5 adds — this writer is its ONLY maintainer; the
//     legacy free-text partners.last_contact is never written here)
//
// Auth/validation/scoping stay in the route (it has the session); this module
// is only the resolved insert + the side-effect.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'

export type TouchpointRow = {
  // Subject: exactly one of the two. lead_id-only callers are the existing
  // contract and compile unchanged.
  lead_id?: string | null
  partner_id?: string | null
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
// subject's side-effect. engagement_id is omitted from the payload entirely
// when absent — matching the route's conditional spread, so a client-level
// touchpoint behaves exactly as before. The absent subject key is likewise
// OMITTED (not null'd): the lead payload shape is identical to the
// pre-partner one.
export async function insertTouchpoint(row: TouchpointRow): Promise<InsertTouchpointResult> {
  const hasLead = typeof row.lead_id === 'string' && row.lead_id.length > 0
  const hasPartner = typeof row.partner_id === 'string' && row.partner_id.length > 0
  if (hasLead === hasPartner) {
    // both or neither — mirrors the DB XOR CHECK so no malformed insert is
    // ever attempted.
    return { ok: false, error: 'exactly_one_subject_required' }
  }

  const insertRow: Record<string, unknown> = {
    ...(hasLead ? { lead_id: row.lead_id } : { partner_id: row.partner_id }),
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

  // Reach-out side effects (mirror each other):
  //   lead    → bump updated_at (the pre-existing behavior, 1:1)
  //   partner → stamp last_contacted_at with the touchpoint's own moment
  //             (occurred_at when backdated, else now) + updated_at
  if (row.kind === 'reach_out') {
    if (hasLead) {
      await supabaseService
        .from('leads')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', row.lead_id)
    } else {
      const contactedAt = row.occurred_at || new Date().toISOString()
      await supabaseService
        .from('partners')
        .update({ last_contacted_at: contactedAt, updated_at: new Date().toISOString() })
        .eq('id', row.partner_id)
    }
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
