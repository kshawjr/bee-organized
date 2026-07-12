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
// onboarding_type derivation: lite_user / manager → 'employee_setup', else
// 'owner_setup'. Lets us track invited-team-member flows separately.

// Invited team members (lite_user + manager) run the employee_setup flow. Their
// progress lives ONLY in the onboarding_progress audit log — the route never
// writes locations.onboarding_state for them (that cache is owner-owned). So
// the client's location-cache seed can't restore employee progress; GET below
// is the authoritative read-back path that closes that gap.
function onboardingTypeFor(role: string | undefined | null) {
  return role === 'lite_user' || role === 'manager'
    ? 'employee_setup'
    : 'owner_setup'
}

// Collapse a user's audit rows for one onboarding_type into the
// { [step]: true } map the client hydrates completedSteps from.
async function readCompletedSteps(userId: string, onboardingType: string) {
  const { data, error } = await supabaseService
    .from('onboarding_progress')
    .select('step')
    .eq('user_id', userId)
    .eq('onboarding_type', onboardingType)
  if (error) {
    console.error('[/api/onboarding/progress] completed read error:', error.message)
    return null
  }
  const completedSteps: Record<string, boolean> = {}
  for (const row of data || []) {
    if (row?.step) completedSteps[row.step] = true
  }
  return completedSteps
}

// GET /api/onboarding/progress
// Returns the authenticated user's completed steps for their onboarding_type.
// This is the read-back path the client uses to restore progress on load —
// essential for employee_setup (manager / lite_user), whose completions are
// NOT mirrored into the owner-owned locations.onboarding_state cache.
export async function GET() {
  try {
    const authUser = await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser) {
      return NextResponse.json({ error: 'No hub user profile' }, { status: 403 })
    }
    const onboardingType = onboardingTypeFor(hubUser.role)
    const completedSteps = await readCompletedSteps(authUser.id, onboardingType)
    if (completedSteps === null) {
      return NextResponse.json({ error: 'Failed to read progress' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, completedSteps })
  } catch (err: any) {
    console.error('[/api/onboarding/progress] GET error:', err?.message || err)
    return NextResponse.json(
      { error: err?.message || 'Server error' },
      { status: 500 }
    )
  }
}

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

    // Invited team members (lite_user + manager) run the employee_setup flow,
    // which skips the locations.onboarding_state cache write below — only the
    // owner owns their location's onboarding. Manager must not mutate it.
    const onboardingType = onboardingTypeFor(hubUser.role)

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

    // Authoritative step set after this write — the client reconciles local
    // completedSteps against this so the read-back path (GET) and the write
    // path agree, including for employee_setup where the location cache is
    // never written.
    const completedSteps = await readCompletedSteps(authUser.id, onboardingType)

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
      const cacheCompletedSteps = {
        ...(existing.completedSteps || {}),
        ...(completedSteps || {}),
        [step]: true,
      }
      // Use the activeStepOpen the client sent if present; otherwise preserve
      // whatever's already cached. Pass null explicitly to clear it.
      const nextActiveStepOpen =
        activeStepOpen !== undefined ? activeStepOpen : existing.activeStepOpen ?? null

      onboardingState = {
        completedSteps: cacheCompletedSteps,
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

    return NextResponse.json({
      ok: true,
      completedSteps: completedSteps || undefined,
      onboarding_state: onboardingState,
    })
  } catch (err: any) {
    console.error('[/api/onboarding/progress] error:', err?.message || err)
    return NextResponse.json(
      { error: err?.message || 'Server error' },
      { status: 500 }
    )
  }
}
