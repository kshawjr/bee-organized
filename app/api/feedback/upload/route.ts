// app/api/feedback/upload/route.ts
//
// POST /api/feedback/upload — single-file upload for feedback attachments.
//
// The client uploads each selected file here BEFORE submitting the feedback
// item, then includes the returned metadata in the POST /api/feedback body's
// attachments array. Files land in the PRIVATE feedback-attachments bucket
// under <user_id>/<uuid>-<sanitized-name> so RLS (and our own path checks)
// can scope access per user.
//
// Auth: any authenticated user. Upload goes through the service-role client so
// it isn't gated by Storage RLS — but the object path is always prefixed with
// the caller's own user_id, matching the RLS folder convention.

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

const BUCKET = 'feedback-attachments'
const MAX_BYTES = 10 * 1024 * 1024 // 10MB

// Keep the original name readable but strip anything that could break a
// Storage path or smuggle traversal. Collapse to a safe ASCII-ish subset.
function sanitizeFilename(name: string): string {
  const base = (name || 'file').split(/[\\/]/).pop() || 'file'
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 120)
  return cleaned || 'file'
}

export async function POST(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 })
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file_required' }, { status: 400 })
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'file_empty' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: 'file_too_large', detail: 'Files must be 10MB or smaller.' },
      { status: 413 },
    )
  }

  const safeName = sanitizeFilename(file.name)
  const path = `${user.id}/${crypto.randomUUID()}-${safeName}`
  const contentType = file.type || 'application/octet-stream'

  const buffer = Buffer.from(await file.arrayBuffer())

  const { error: uploadErr } = await supabaseService.storage
    .from(BUCKET)
    .upload(path, buffer, {
      contentType,
      upsert: false,
    })

  if (uploadErr) {
    console.error('[feedback upload]', uploadErr)
    return NextResponse.json(
      { error: 'upload_failed', detail: uploadErr.message },
      { status: 500 },
    )
  }

  return NextResponse.json({
    path,
    name: safeName,
    size: file.size,
    type: contentType,
  })
}
