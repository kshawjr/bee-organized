// app/api/pending_invites/[id]/route.ts
//
// DELETE — revoke a pending invite. Hard delete: the row is gone, the
// invite_token stops working immediately (the accept route returns 404),
// and seat-availability counts free up. We accept the loss of the
// "was invited then revoked" audit trail in exchange for a clean
// data model — see the discussion in cleanup_orphan_hub_users.sql for
// the kind of drift we're trying to avoid.
//
// Auth: super_admin/admin OR the owner of the invite's location.
// Corporate (location-less) invites: super_admin only.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const inviteId = params.id
  if (!inviteId) {
    return NextResponse.json({ error: 'id required' }, { status: 400 })
  }

  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!caller) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data: invite, error: inviteErr } = await supabaseService
    .from('pending_invites')
    .select('id, location_id, tier, accepted_at')
    .eq('id', inviteId)
    .maybeSingle()
  if (inviteErr) {
    console.error('[pending_invites DELETE fetch]', inviteErr)
    return NextResponse.json({ error: inviteErr.message }, { status: 500 })
  }
  if (!invite) {
    return NextResponse.json({ error: 'invite not found' }, { status: 404 })
  }
  if (invite.accepted_at) {
    return NextResponse.json(
      { error: 'invite already accepted — remove the user via the team panel instead' },
      { status: 409 }
    )
  }

  const isCorporateInvite = invite.tier === 'admin' || !invite.location_id
  if (isCorporateInvite) {
    if (caller.role !== 'super_admin') {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  } else {
    const isOwnerOfLocation =
      caller.role === 'owner' && caller.location_id === invite.location_id
    if (!isElevated(caller.role) && !isOwnerOfLocation) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  }

  const { error: delErr } = await supabaseService
    .from('pending_invites')
    .delete()
    .eq('id', inviteId)
  if (delErr) {
    console.error('[pending_invites DELETE]', delErr)
    return NextResponse.json({ error: delErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
