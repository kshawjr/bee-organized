// app/api/client-files/route.ts
//
//   GET  /api/client-files?lead_id=…[&engagement_id=…]   the list (and so the count)
//   POST /api/client-files   multipart: file, lead_id, [engagement_id], [thumb]
//
// A client's files: photos and PDFs. Rules, path scheme and limits are in
// lib/client-files.ts — read its header first.
//
// FOLLOWS app/api/feedback/upload/route.ts: a private bucket, the service-role
// client, a readable-but-cleaned file name with traversal stripped, a size cap.
// DEPARTS from it in five places, each on purpose:
//   1. the object is filed under the CLIENT, not the uploader;
//   2. the cap is 4 MB, because Vercel refuses a request over 4.5 MB before
//      this code runs, so feedback's 10 MB cannot actually be reached;
//   3. only photos and PDFs, decided from the file's own first bytes
//      (feedback takes any type, on the browser's word);
//   4. every file has a row in client_files (who, when, which job), so the
//      tab has a real count and a real order;
//   5. the bucket is checked to be private before every upload.
//
// Auth: signed in, and the client is at your location (corporate: any).
// Adding also needs a role that may write and a location that is not paused.

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { supabaseService } from '@/lib/supabase-service'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import {
  CLIENT_FILES_BUCKET, CLIENT_FILES_TABLE, MAX_FILE_BYTES, MAX_THUMB_BYTES, WORDS,
  canRemoveClientFile, clientFilePath, clientThumbPath, displayName, isMissingFilesTable, isUuid,
  roleMayChangeFiles, sniffFileType,
} from '@/lib/client-files'
import { bucketProblem, callerLabel, filesCaller, leadForFiles, removeClientFileObjects } from '@/lib/client-files-server'

export const runtime = 'nodejs'

const no = (error: string, status: number, detail?: string) =>
  NextResponse.json(detail ? { error, detail } : { error }, { status })

// What the browser is given about a file. NEVER the Storage path: the browser
// asks for a file by its id, and the server looks the path up.
const forBrowser = (row: any, caller: { id: string; role: string }) => ({
  id: row.id,
  name: row.name,
  mime_type: row.mime_type,
  size_bytes: row.size_bytes,
  engagement_id: row.engagement_id ?? null,
  uploaded_by_label: row.uploaded_by_label,
  created_at: row.created_at,
  has_preview: !!row.thumb_path,
  can_remove: canRemoveClientFile(caller, row),
})

export async function GET(req: NextRequest) {
  const who = await filesCaller()
  if ('refuse' in who) return who.refuse
  const { caller } = who

  const url = new URL(req.url)
  const leadId = url.searchParams.get('lead_id')
  const engagementId = url.searchParams.get('engagement_id')
  if (!isUuid(leadId)) return no('lead_id_required', 400)
  if (engagementId !== null && !isUuid(engagementId)) return no('invalid_engagement_id', 400)

  const found = await leadForFiles(caller, leadId)
  if ('refuse' in found) return found.refuse

  let query = supabaseService
    .from(CLIENT_FILES_TABLE)
    .select('id, lead_id, engagement_id, name, mime_type, size_bytes, thumb_path, uploaded_by, uploaded_by_label, created_at')
    .eq('lead_id', leadId)
  if (engagementId) query = query.eq('engagement_id', engagementId)
  const { data, error } = await query.order('created_at', { ascending: false })

  if (error) {
    // The migration has not been run yet: an empty tab that says so, not a
    // broken card.
    if (isMissingFilesTable(error)) return NextResponse.json({ files: [], not_ready: true })
    console.error('[client files list]', error)
    return no('list_failed', 500)
  }

  return NextResponse.json({ files: (data || []).map(r => forBrowser(r, caller)) })
}

export async function POST(req: NextRequest) {
  const who = await filesCaller()
  if ('refuse' in who) return who.refuse
  const { caller } = who

  // Role first, before a single byte of the file is read.
  if (!roleMayChangeFiles(caller.role)) return no('forbidden_read_only_role', 403, WORDS.readOnly)

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return no('invalid_form_data', 400)
  }

  const leadId = form.get('lead_id')
  const engagementRaw = form.get('engagement_id')
  const engagementId = typeof engagementRaw === 'string' && engagementRaw ? engagementRaw : null
  if (!isUuid(leadId)) return no('lead_id_required', 400)
  if (engagementId !== null && !isUuid(engagementId)) return no('invalid_engagement_id', 400)

  const found = await leadForFiles(caller, leadId)
  if ('refuse' in found) return found.refuse
  const { lead } = found

  const roBlock = await readOnlyWriteBlock(caller, lead.location_uuid)
  if (roBlock) return roBlock

  if (lead.is_junk) return no('client_in_bin', 409, WORDS.inBin)

  // A job's file must be on a job that is THIS client's.
  if (engagementId) {
    const { data: eng } = await supabaseService
      .from('engagements')
      .select('id, client_id')
      .eq('id', engagementId)
      .maybeSingle()
    if (!eng || eng.client_id !== leadId) return no('engagement_not_on_lead', 400)
  }

  const file = form.get('file')
  if (!(file instanceof File)) return no('file_required', 400)
  if (file.size === 0) return no('file_empty', 400, WORDS.empty)
  if (file.size > MAX_FILE_BYTES) return no('file_too_large', 413, WORDS.tooBig)

  const buffer = Buffer.from(await file.arrayBuffer())
  const type = sniffFileType(buffer)
  if (!type) return no('file_type_not_allowed', 415, WORDS.wrongType)

  // The small preview picture the browser made. Optional, and only ever a
  // small JPEG: anything else is dropped without failing the upload.
  let thumbBuffer: Buffer | null = null
  const thumb = form.get('thumb')
  if (thumb instanceof File && thumb.size > 0 && thumb.size <= MAX_THUMB_BYTES) {
    const tb = Buffer.from(await thumb.arrayBuffer())
    if (sniffFileType(tb) === 'image/jpeg') thumbBuffer = tb
  }

  const problem = await bucketProblem()
  if (problem === 'missing') return no('files_not_ready', 503, WORDS.notSwitchedOn)
  if (problem === 'public') {
    console.error('[client files] REFUSED: the client-files bucket is PUBLIC. Nothing was stored. Make it private in Supabase.')
    return no('files_bucket_not_private', 503, WORDS.generic)
  }

  const uuid = crypto.randomUUID()
  const path = clientFilePath(leadId, uuid, file.name)
  const thumbPath = thumbBuffer ? clientThumbPath(leadId, uuid) : null
  const bucket = supabaseService.storage.from(CLIENT_FILES_BUCKET)

  const { error: uploadErr } = await bucket.upload(path, buffer, { contentType: type, upsert: false })
  if (uploadErr) {
    console.error('[client files upload]', uploadErr)
    return no('upload_failed', 500, WORDS.generic)
  }

  let storedThumb: string | null = null
  if (thumbBuffer && thumbPath) {
    const { error: thumbErr } = await bucket.upload(thumbPath, thumbBuffer, { contentType: 'image/jpeg', upsert: false })
    if (thumbErr) console.warn('[client files upload] preview not stored (the file itself was):', thumbErr.message)
    else storedThumb = thumbPath
  }

  const { data: row, error: insertErr } = await supabaseService
    .from(CLIENT_FILES_TABLE)
    .insert({
      lead_id: leadId,
      engagement_id: engagementId,
      path,
      thumb_path: storedThumb,
      name: displayName(file.name),
      mime_type: type,
      size_bytes: file.size,
      uploaded_by: caller.id,
      uploaded_by_label: callerLabel(caller),
    })
    .select('id, lead_id, engagement_id, name, mime_type, size_bytes, thumb_path, uploaded_by, uploaded_by_label, created_at')
    .single()

  if (insertErr || !row) {
    // A file with no row is a file nobody can find, count or remove. Take it
    // back out rather than leave it.
    await removeClientFileObjects([path, ...(storedThumb ? [storedThumb] : [])], 'row insert failed after upload')
    if (isMissingFilesTable(insertErr)) return no('files_not_ready', 503, WORDS.notSwitchedOn)
    console.error('[client files upload] row insert failed', insertErr)
    return no('upload_failed', 500, WORDS.generic)
  }

  return NextResponse.json({ file: forBrowser(row, caller) }, { status: 201 })
}
