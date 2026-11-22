// app/api/partners/[id]/unsubscribe/reverse/route.ts
//
// POST — a SUPER ADMIN reverses an OWNER's unsubscribe mark on a Network
// contact. Partner emails, slice 2. No screen calls it yet.
//
// Super admin only (hub_users.role = 'super_admin', lib/auth isSuperAdmin —
// not admin, not owner), checked here AND again by the database function.
// A partner's OWN unsubscribe (they pressed the button on their link) can
// never be reversed, by anyone: the answer is 409 and nothing changes. The
// history keeps the mark and the reversal, with who and when.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { loadCaller } from '@/lib/crm'
import { isSuperAdmin } from '@/lib/auth'
import { reversePartnerUnsubscribe } from '@/lib/network/partner-unsubscribe'

export const runtime = 'nodejs'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const caller = await loadCaller(await createServerSupabaseClient())
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSuperAdmin(caller.role)) return NextResponse.json({ error: 'super_admin_only' }, { status: 403 })

  const { outcome, stillBlocked } = await reversePartnerUnsubscribe(id, caller.userId)
  switch (outcome) {
    case 'reversed':
      // stillBlocked: e.g. the same address is unsubscribed on another contact.
      return NextResponse.json({ ok: true, outcome, still_blocked: stillBlocked })
    case 'partner_unsubscribed_themselves':
      return NextResponse.json({ error: 'partner_unsubscribed_themselves' }, { status: 409 })
    case 'not_unsubscribed':
      return NextResponse.json({ error: 'not_unsubscribed', still_blocked: stillBlocked }, { status: 409 })
    case 'not_super_admin':
      return NextResponse.json({ error: 'super_admin_only' }, { status: 403 })
    case 'not_found':
      return NextResponse.json({ error: 'partner_not_found' }, { status: 404 })
    default:
      return NextResponse.json({ error: 'reverse_failed' }, { status: 500 })
  }
}
