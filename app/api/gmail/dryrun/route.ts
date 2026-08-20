// app/api/gmail/dryrun/route.ts
//
// GET /api/gmail/dryrun?email=<user>@beeorganized.com&days=7&maxMessages=200
// super_admin only — dry-run lead matching over recent mailbox METADATA.
// Returns aggregate counts only: no subjects, addresses, names, snippets,
// or lead ids, in the response or in any log line. Zero database writes.
//
// On time-budget exhaustion dryRunMailbox returns partial results with
// capHit true rather than letting the function time out.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import {
  dryRunMailbox,
  DRYRUN_DAYS_DEFAULT,
  DRYRUN_DAYS_MAX,
  DRYRUN_MAX_MESSAGES_DEFAULT,
  DRYRUN_MAX_MESSAGES_CEILING,
} from '@/lib/gmail-dryrun'

export const runtime = 'nodejs'
export const maxDuration = 60

const ALLOWED_DOMAIN = '@beeorganized.com'
// Leave headroom under maxDuration for auth, response serialization, and
// the final lead query pass.
const TIME_BUDGET_MS = 45_000

function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number.parseInt(raw, 10)
  if (Number.isNaN(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (hubUser?.role !== 'super_admin') {
    return NextResponse.json({ error: 'forbidden — super_admin only' }, { status: 403 })
  }

  const email = request.nextUrl.searchParams.get('email')?.trim().toLowerCase() || ''
  if (!email.endsWith(ALLOWED_DOMAIN) || email === ALLOWED_DOMAIN) {
    return NextResponse.json(
      { error: `email must be a ${ALLOWED_DOMAIN} address` },
      { status: 400 }
    )
  }

  const days = intParam(request.nextUrl.searchParams.get('days'), DRYRUN_DAYS_DEFAULT, 1, DRYRUN_DAYS_MAX)
  const maxMessages = intParam(
    request.nextUrl.searchParams.get('maxMessages'),
    DRYRUN_MAX_MESSAGES_DEFAULT,
    1,
    DRYRUN_MAX_MESSAGES_CEILING
  )

  try {
    const result = await dryRunMailbox(email, { days, maxMessages, timeBudgetMs: TIME_BUDGET_MS })
    return NextResponse.json(result)
  } catch (err: any) {
    // Error messages here carry Google/PostgREST diagnostics but never
    // subjects, participant addresses, or lead ids.
    console.error('[gmail/dryrun]', err?.message || err)
    return NextResponse.json(
      { error: err?.message || 'dry run failed' },
      { status: 502 }
    )
  }
}
