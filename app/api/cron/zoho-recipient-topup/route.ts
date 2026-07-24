// app/api/cron/zoho-recipient-topup/route.ts
//
// GET /api/cron/zoho-recipient-topup — Vercel cron entrypoint, fires nightly
// (vercel.json: "0 5 * * *" UTC ≈ 1am ET). Deliberately OFF the top of the
// hour that send-drips owns, so the two don't contend.
//
// Keeps Bee Hub's lead-notification recipients topped up from Zoho while Zoho
// is still the system of record for franchisee contacts: for every location
// that has no owner/manager hub_user, insert the Zoho contacts Bee Hub lacks.
//
// ADDITIVE ONLY — never updates, never deletes. A recipient removed in the UI
// stays removed; an edited name/category is never overwritten. The only write
// is an INSERT of an email the location doesn't already have. That makes the
// job safe to re-run and safe to run alongside humans editing the same list.
//
// The scope + mapping + dedupe all live in lib/zoho-recipient-topup.ts, shared
// verbatim with scripts/seed-notification-externals.mjs (the one-time seed is
// just this job's first run). Scope is recomputed every run, so a location that
// gains an owner drops out automatically.
//
// Auth: same convention as send-drips / webhook-digest — Vercel cron sends
// `Authorization: Bearer <CRON_SECRET>`; manual testing also accepts
// `?secret=<value>`. Missing CRON_SECRET is fail-closed (500).
//
// A Zoho failure for one location is reported in `errors` and the run
// continues (200) — one dead slug must not deny every other location its
// recipients. A total failure (locations/hub_users unreadable) is a 500.
//
// CRON REGISTRATION CAVEAT: Vercel crons pin to the deployment that registered
// them — after this lands, check the Vercel dashboard's Cron tab and Redeploy
// if the new cron didn't register.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { getZohoLocationNotificationContacts } from '@/lib/zoho'
import { buildTopUpPlan, commitTopUpPlan } from '@/lib/zoho-recipient-topup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// ~2 sequential Zoho GETs per in-scope location (44 live → ~88 calls, measured
// well under a minute). Generous ceiling so a slow Zoho day degrades into a
// long run rather than a truncated one that silently skips the tail.
export const maxDuration = 300

export async function GET(req: NextRequest) {
  // ─── Auth ──────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron] CRON_SECRET not set; refusing to run')
    return NextResponse.json({ error: 'cron_secret_not_configured' }, { status: 500 })
  }
  const header = req.headers.get('authorization')
  const expected = `Bearer ${secret}`
  const queryToken = req.nextUrl.searchParams.get('secret')
  if (header !== expected && queryToken !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // ─── Plan ──────────────────────────────────────────────────────
  let plan
  try {
    plan = await buildTopUpPlan({
      supabase: supabaseService,
      fetchZohoContacts: getZohoLocationNotificationContacts,
    })
  } catch (e: any) {
    console.error('[cron] zoho-recipient-topup plan failed:', e?.message || e)
    return NextResponse.json({ error: 'plan_failed' }, { status: 500 })
  }

  // ─── Commit ────────────────────────────────────────────────────
  const { inserted, errors } = await commitTopUpPlan({ supabase: supabaseService }, plan)

  const zohoErrors = plan.locations
    .filter((l) => l.error)
    .map((l) => ({ slug: l.location.slug, reason: l.error as string }))

  if (inserted > 0) {
    console.log(
      `[cron] zoho-recipient-topup added ${inserted} recipient(s) across ` +
        `${plan.locations.filter((l) => l.rows.length > 0).length} location(s)`,
    )
  }

  return NextResponse.json({
    locations_in_scope: plan.locations.length,
    locations_with_additions: plan.locations.filter((l) => l.rows.length > 0).length,
    planned: plan.rows.length,
    inserted,
    // Addresses skipped because they already belong to a hub_user at their
    // location — the cross-table dedupe. Nonzero is normal, not an error.
    skipped_hub_user_owned: plan.locations.reduce((n, l) => n + l.userOwned, 0),
    errors: [...zohoErrors, ...errors].slice(0, 20),
  })
}
