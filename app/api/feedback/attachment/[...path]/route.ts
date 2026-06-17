// app/api/feedback/attachment/[...path]/route.ts
//
// GET /api/feedback/attachment/<path> — issue a short-lived signed URL for a
// feedback attachment and redirect the browser to it.
//
// The object path is captured as a catch-all segment ([...path]) because
// Storage paths contain a slash (<user_id>/<uuid>-<name>). Access is allowed
// when EITHER the path belongs to the caller (path's first segment ==
// caller's user_id) OR the caller is super_admin / admin (the corp tier).
//
// We redirect (302) to the signed URL rather than returning JSON so a plain
// <a href> click opens/downloads the file directly — no extra fetch hop.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

const BUCKET = 'feedback-attachments'
const SIGNED_TTL_SECONDS = 60 * 60 // 1 hour
const ADMIN_ROLES = ['super_admin', 'admin']

export async function GET(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // Reassemble the object path from the catch-all segments. Each segment is
  // URL-encoded in the request, so decode before handing to Storage.
  const segments = Array.isArray(params.path) ? params.path : []
  const objectPath = segments.map(s => decodeURIComponent(s)).join('/')
  if (!objectPath || objectPath.includes('..')) {
    return NextResponse.json({ error: 'invalid_path' }, { status: 400 })
  }

  const ownsPath = objectPath.split('/')[0] === user.id

  let allowed = ownsPath
  if (!allowed) {
    const { data: caller } = await supabase
      .from('hub_users')
      .select('role')
      .eq('id', user.id)
      .single()
    allowed = !!caller && ADMIN_ROLES.includes(caller.role)
  }
  if (!allowed) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data, error } = await supabaseService.storage
    .from(BUCKET)
    .createSignedUrl(objectPath, SIGNED_TTL_SECONDS)

  if (error || !data?.signedUrl) {
    console.error('[feedback attachment sign]', error)
    return NextResponse.json(
      { error: 'sign_failed', detail: error?.message },
      { status: 500 },
    )
  }

  return NextResponse.redirect(data.signedUrl)
}
