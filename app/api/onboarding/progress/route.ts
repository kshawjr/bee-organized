import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'

// POST /api/onboarding/progress
// Body: { step: string, metadata?: object, activeStepOpen?: string|null }
//
// Records step completion to two places:
//   1. onboarding_progress (audit log) — upsert on (user_id, onboarding_type, step)
//   2. locations.onboarding_state (jsonb cache) — merged completedSteps map +
//      latest activeStepOpen + lastUpdated. Only written for owner_setup with
//      a location_id; employee_setup flows skip the cache write.
//
// The audit log is authoritative; the jsonb cache exists for fast page-load
// hydration in app/page.tsx without an extra round trip. If the cache write
// fails the audit row is still recorded — sessionStorage in the client picks
// up the slack until the next successful write.
//
// onboarding_type derivation: lite_user → 'employee_setup', else 'owner_setup'.
// Lets us track invited-team-member flows separately once Pass 2 adds them.

export async function POST(req: NextRequest) {
  try {
    const authUser = await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser) {
      return NextResponse.json({ error: 'No hub user profile' }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const { step, metadata, activeStepOpen } = (body || {}) as {
      step?: string
      metadata?: Record<string, unknown>
      activeStepOpen?: string | null
    }

    if (!step || typeof step !== 'string') {
      return NextResponse.json({ error: 'step is required' }, { status: 400 })
    }

    const onboardingType =
      hubUser.role === 'lite_user' ? 'employee_setup' : 'owner_setup'

    // ─── 1. Audit log (upsert) ────────────────────────────────────────────────
    const { error: progressErr } = await supabaseService
      .from('onboarding_progress')
      .upsert(
        {
          user_id: authUser.id,
          location_id: hubUser.location_id || null,
          onboarding_type: onboardingType,
          step,
          completed_at: new Date().toISOString(),
          completed_by: authUser.id,
          metadata: metadata || {},
        },
        { onConflict: 'user_id,onboarding_type,step' }
      )

    if (progressErr) {
      console.error('[/api/onboarding/progress] audit upsert error:', progressErr.message)
      return NextResponse.json(
        { error: 'Failed to record progress' },
        { status: 500 }
      )
    }

    // ─── 2. locations.onboarding_state cache (owner_setup with location only) ─
    let onboardingState: {
      completedSteps: Record<string, boolean>
      activeStepOpen: string | null
      lastUpdated: string
    } | null = null

    if (onboardingType === 'owner_setup' && hubUser.location_id) {
      const { data: locRow, error: locReadErr } = await supabaseService
        .from('locations')
        .select('onboarding_state')
        .eq('id', hubUser.location_id)
        .single()

      if (locReadErr) {
        console.error('[/api/onboarding/progress] locations read error:', locReadErr.message)
      }

      const existing = (locRow?.onboarding_state as any) || {}
      const completedSteps = {
        ...(existing.completedSteps || {}),
        [step]: true,
      }
      // Use the activeStepOpen the client sent if present; otherwise preserve
      // whatever's already cached. Pass null explicitly to clear it.
      const nextActiveStepOpen =
        activeStepOpen !== undefined ? activeStepOpen : existing.activeStepOpen ?? null

      onboardingState = {
        completedSteps,
        activeStepOpen: nextActiveStepOpen,
        lastUpdated: new Date().toISOString(),
      }

      const { error: locWriteErr } = await supabaseService
        .from('locations')
        .update({ onboarding_state: onboardingState })
        .eq('id', hubUser.location_id)

      if (locWriteErr) {
        // Audit row is already recorded; cache miss is non-fatal. Log and
        // continue — next successful write will reconcile.
        console.error('[/api/onboarding/progress] locations update error:', locWriteErr.message)
      }
    }

    return NextResponse.json({ ok: true, onboarding_state: onboardingState })
  } catch (err: any) {
    console.error('[/api/onboarding/progress] error:', err?.message || err)
    return NextResponse.json(
      { error: err?.message || 'Server error' },
      { status: 500 }
    )
  }
}
