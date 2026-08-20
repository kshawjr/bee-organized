// app/api/gmail/test/route.ts
//
// GET /api/gmail/test?email=<user>@beeorganized.com
// super_admin only — proves domain-wide delegation works by impersonating
// the given Workspace user and fetching their Gmail profile.
//
// Returns COUNTS only (emailAddress, messagesTotal, threadsTotal, historyId).
// This route must never expose mailbox contents — no subjects, snippets,
// senders, or bodies.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { getProfile } from '@/lib/gmail'

export const runtime = 'nodejs'

const ALLOWED_DOMAIN = '@beeorganized.com'

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

  try {
    const profile = await getProfile(email)
    return NextResponse.json(profile)
  } catch (err: any) {
    console.error('[gmail/test]', err?.message || err)
    return NextResponse.json(
      { error: err?.message || 'Gmail profile fetch failed' },
      { status: 502 }
    )
  }
}
