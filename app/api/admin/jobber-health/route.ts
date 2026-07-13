// app/api/admin/jobber-health/route.ts
//
// Read-only Jobber connection health for EVERY location. Kevin's operational
// source of truth pre-launch: as super_admin he couldn't trust the per-location
// "Connected" flag (it hid a 2-month dead-token outage, then over-corrected and
// false-alarmed on normally-expired-but-refreshable tokens).
//
// The status is derived by the SAME shared helper the connection card uses
// (lib/jobber-status.ts jobberStatusView) — no parallel logic. Token presence
// is read here with the service-role client and collapsed to BOOLEANS; the raw
// access / refresh tokens are NEVER included in the response (token purity).
//
// Auth: super_admin / admin only (403 otherwise).

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { jobberStatusView, type JobberStatus } from '@/lib/jobber-status'

export const runtime = 'nodejs'

function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
}

// reconnect_required floats to the top (the problem group), then connected,
// then never-connected. Ties break by name.
const STATUS_RANK: Record<JobberStatus, number> = {
  reconnect_required: 0,
  connected: 1,
  disconnected: 2,
}

export async function GET(_request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role')
    .eq('id', user.id)
    .single()
  if (!caller || !isElevated(caller.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Service-role read: the token columns are selected ONLY to compute presence
  // booleans below — they never leave this function.
  const { data: rows, error } = await supabaseService
    .from('locations')
    .select(
      'id, location_id, slug, name, jobber_connected, jobber_account_name, ' +
        'jobber_access_token, jobber_refresh_token, token_expiry, token_expiry_display, ' +
        'last_sync_status, lifecycle_status, updated_at',
    )
    .order('name', { ascending: true })

  if (error) {
    console.error('[jobber-health] locations query error', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const locations = (rows || []).map((r: any) => {
    const hasAccessToken = !!r.jobber_access_token
    const hasRefreshToken = !!r.jobber_refresh_token
    const view = jobberStatusView({
      connected: !!r.jobber_connected,
      tokenExpiry: r.token_expiry ?? null,
      lastSyncStatus: r.last_sync_status ?? null,
      hasAccessToken,
      hasRefreshToken,
    })
    return {
      id: r.id,
      // Prefer the human slug; fall back to the internal slug column then UUID.
      slug: r.location_id || r.slug || r.id,
      name: r.name || '—',
      status: view.status,
      label: view.label,
      tone: view.tone,
      autoRefreshing: view.autoRefreshing,
      accountName: r.jobber_account_name || null,
      tokenExpiry: r.token_expiry ?? null,
      tokenExpiryDisplay: r.token_expiry_display || null,
      lastSyncStatus: r.last_sync_status || null,
      lifecycleStatus: r.lifecycle_status || null,
      updatedAt: r.updated_at || null,
      // Presence booleans only — never the tokens themselves.
      hasAccessToken,
      hasRefreshToken,
    }
  })

  locations.sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status]
    return rank !== 0 ? rank : a.name.localeCompare(b.name)
  })

  const summary = {
    total: locations.length,
    reconnect_required: locations.filter(l => l.status === 'reconnect_required').length,
    connected: locations.filter(l => l.status === 'connected').length,
    auto_refreshing: locations.filter(l => l.autoRefreshing).length,
    disconnected: locations.filter(l => l.status === 'disconnected').length,
  }

  return NextResponse.json({ generatedAt: new Date().toISOString(), summary, locations })
}
