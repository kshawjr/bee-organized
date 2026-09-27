// app/api/signature/photo/route.ts
//
//   POST /api/signature/photo  { type, size }  →  { path, token }
//
// The server half of a headshot upload for the email signature. Same shape as
// /api/help/media/sign: the bytes never touch this server — the route checks
// the caller, checks the declared type and size, and mints a ONE-SHOT signed
// upload token for a path it chooses: <caller's own user id>/<random>.jpg.
// The browser then PUTs the (already shrunk) file straight into the
// email-signatures bucket, whose own 1 MB / JPEG+PNG limits re-check it.
//
// Nobody can write anywhere else: no storage.objects policy grants INSERT,
// and the path is never taken from the request. Saving the photo onto the
// profile is a separate PATCH /api/hub_users/me { signature_photo_path },
// which re-checks the path belongs to the caller and the file exists.

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { getHubUser } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import { SIGNATURE_PHOTO_BUCKET } from '@/lib/email-signature'
import { SIGNATURE_PHOTO_MAX_BYTES, signaturePhotoProblem } from '@/lib/signature-photo-rules'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const hubUser = await getHubUser()
  if (!hubUser) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (hubUser.is_active === false || hubUser.disabled_at) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { type?: unknown; size?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 }) }

  const type = String(body.type ?? '').toLowerCase()
  const size = Number(body.size)
  const problem = signaturePhotoProblem(type, size)
  if (problem) return NextResponse.json({ error: problem }, { status: size > SIGNATURE_PHOTO_MAX_BYTES ? 413 : 400 })

  const ext = type === 'image/png' ? 'png' : 'jpg'
  const path = `${hubUser.id}/${crypto.randomUUID()}.${ext}`
  const { data, error } = await supabaseService.storage.from(SIGNATURE_PHOTO_BUCKET).createSignedUploadUrl(path)
  if (error || !data?.token) {
    console.error('[signature photo sign]', error)
    const msg = String(error?.message || '')
    const notSetUp = /bucket/i.test(msg) && /not found|does not exist/i.test(msg)
    return NextResponse.json(
      { error: notSetUp ? 'Photo storage isn’t switched on yet — migrations/email_signatures.sql has not been run.' : 'Couldn’t prepare the upload. Please try again.' },
      { status: notSetUp ? 503 : 500 },
    )
  }
  return NextResponse.json({ path, token: data.token })
}
