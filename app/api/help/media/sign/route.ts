// app/api/help/media/sign/route.ts
//
//   POST /api/help/media/sign  { name, type, size, seconds? }
//   → { path, token, publicUrl, kind }
//
// WHY A SIGNED UPLOAD URL AND NOT A MULTIPART POST. Vercel caps a function's
// request body at 4.5 MB; a one-minute phone video is ten times that. So the
// bytes never touch this server: the route checks the caller is an editor,
// checks the declared size and type against the limits, mints a one-shot
// signed upload URL with the service role, and the browser PUTs the file
// straight into the help-media bucket. The bucket's own file_size_limit and
// allowed_mime_types re-check the file when it actually lands.
//
// Editors only. No storage.objects policy grants anyone an INSERT; this
// token is the only way in.

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import {
  HELP_MEDIA_BUCKET, helpMediaPath, helpMediaUrl, isHelpEditorRole, mediaKindForType, mediaLimitProblem,
} from '@/lib/help-content'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: me } = await supabase.from('hub_users').select('role').eq('id', user.id).single()
  if (!isHelpEditorRole(me?.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  let body: { name?: unknown; type?: unknown; size?: unknown; seconds?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 }) }

  const type = String(body.type ?? '').toLowerCase()
  const kind = mediaKindForType(type)
  if (!kind) {
    return NextResponse.json(
      { error: 'That file type isn’t supported. Videos: MP4, MOV or WebM. Screenshots: PNG, JPG, WebP or GIF.' },
      { status: 400 },
    )
  }
  const size = Number(body.size)
  if (!Number.isFinite(size) || size <= 0) return NextResponse.json({ error: 'The file looks empty.' }, { status: 400 })
  const seconds = body.seconds == null ? null : Number(body.seconds)
  const problem = mediaLimitProblem(kind, size, seconds)
  if (problem) return NextResponse.json({ error: problem }, { status: 413 })

  const path = helpMediaPath(kind, type, crypto.randomUUID())
  const { data, error } = await supabaseService.storage.from(HELP_MEDIA_BUCKET).createSignedUploadUrl(path)
  if (error || !data?.token) {
    console.error('[help media sign]', error)
    const msg = String(error?.message || '')
    const notSetUp = /bucket/i.test(msg) && /not found|does not exist/i.test(msg)
    return NextResponse.json(
      { error: notSetUp ? 'The help-media bucket doesn’t exist yet — run migrations/help_entries.sql.' : 'Couldn’t prepare the upload. Please try again.' },
      { status: notSetUp ? 503 : 500 },
    )
  }

  return NextResponse.json({
    path,
    token: data.token,
    kind,
    publicUrl: helpMediaUrl(path),
  })
}
