// app/api/client-files/[id]/route.ts
//
//   GET    /api/client-files/<file id>            the file itself
//   GET    /api/client-files/<file id>?preview=1  its small preview picture
//   GET    /api/client-files/<file id>?download=1 the file, as a download
//   DELETE /api/client-files/<file id>            remove it, for good
//
// HOW A FILE IS SERVED, AND WHY NOT LIKE FEEDBACK. The feedback route hands
// the browser a signed Storage link that works for an hour for ANYONE who has
// it — signed in or not, at Bee Hub or not. That is a fair trade for a
// screenshot of a bug. It is the wrong one for a photo of the inside of
// someone's home. So this route never makes a link at all: it checks who is
// asking, fetches the bytes with the service role, and sends the bytes back
// itself. The address of a file is /api/client-files/<id>, and it only ever
// answers a signed-in person who can see that client right now. Pasted to
// someone outside Bee Hub, it is a login page. There is nothing to expire and
// nothing to leak. (Possible because a file is at most 4 MB, under Vercel's
// 4.5 MB response limit.)
//
// A file is asked for by its ID, never by its Storage path. There is no route
// that takes a path, so there is no path to guess.
//
// `private, no-cache`: the browser may keep its own copy but must ask again
// every time, and "ask again" runs the whole access check before the 304.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import {
  CLIENT_FILES_BUCKET, CLIENT_FILES_TABLE, WORDS, canRemoveClientFile, isMissingFilesTable, isUuid,
  roleMayChangeFiles, storageSafeName,
} from '@/lib/client-files'
import { filesCaller, leadForFiles, removeClientFileObjects } from '@/lib/client-files-server'

export const runtime = 'nodejs'

const no = (error: string, status: number, detail?: string) =>
  NextResponse.json(detail ? { error, detail } : { error }, { status })

type FileRow = {
  id: string
  lead_id: string
  path: string
  thumb_path: string | null
  name: string
  mime_type: string
  uploaded_by: string | null
}

async function fileRow(id: string): Promise<{ row: FileRow } | { refuse: NextResponse }> {
  // Not a file id (a path, say): there is nothing to look up.
  if (!isUuid(id)) return { refuse: no('file_not_found', 404) }
  const { data, error } = await supabaseService
    .from(CLIENT_FILES_TABLE)
    .select('id, lead_id, path, thumb_path, name, mime_type, uploaded_by')
    .eq('id', id)
    .maybeSingle()
  if (error && !isMissingFilesTable(error)) {
    console.error('[client files] row read failed', error)
    return { refuse: no('read_failed', 500) }
  }
  if (!data) return { refuse: no('file_not_found', 404) }
  return { row: data as FileRow }
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const who = await filesCaller()
  if ('refuse' in who) return who.refuse
  const { caller } = who

  const got = await fileRow(params.id)
  if ('refuse' in got) return got.refuse
  const { row } = got

  // Where the client is filed NOW decides it — not where they were when the
  // file was added.
  const found = await leadForFiles(caller, row.lead_id)
  if ('refuse' in found) return found.refuse

  const url = new URL(req.url)
  const wantPreview = url.searchParams.get('preview') === '1'
  const asDownload = url.searchParams.get('download') === '1'
  if (wantPreview && !row.thumb_path) return no('no_preview', 404)

  const objectPath = wantPreview ? (row.thumb_path as string) : row.path
  const etag = `"${row.id}${wantPreview ? '-p' : ''}"`
  const baseHeaders: Record<string, string> = {
    'Cache-Control': 'private, no-cache',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }
  // A file never changes once stored, so "still the one you have" is always
  // yes — but only after every check above has passed again.
  if (req.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers: baseHeaders })
  }

  const { data: blob, error } = await supabaseService.storage.from(CLIENT_FILES_BUCKET).download(objectPath)
  if (error || !blob) {
    console.error('[client files] download failed', row.id, error?.message)
    return no('file_missing_from_storage', 404)
  }

  const asciiName = storageSafeName(row.name)
  const disposition = `${asDownload ? 'attachment' : 'inline'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(row.name)}`
  const bytes = Buffer.from(await blob.arrayBuffer())
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      ...baseHeaders,
      // The type decided from the file's bytes at upload, never a guess now.
      'Content-Type': wantPreview ? 'image/jpeg' : row.mime_type,
      'Content-Length': String(bytes.length),
      'Content-Disposition': disposition,
    },
  })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const who = await filesCaller()
  if ('refuse' in who) return who.refuse
  const { caller } = who

  if (!roleMayChangeFiles(caller.role)) return no('forbidden_read_only_role', 403, WORDS.readOnly)

  const got = await fileRow(params.id)
  if ('refuse' in got) return got.refuse
  const { row } = got

  const found = await leadForFiles(caller, row.lead_id)
  if ('refuse' in found) return found.refuse

  const roBlock = await readOnlyWriteBlock(caller, found.lead.location_uuid)
  if (roBlock) return roBlock

  if (!canRemoveClientFile(caller, row)) return no('forbidden_not_yours', 403, 'Only the person who added a file, or the owner, can remove it.')

  // The row first. If that fails, nothing has changed. If the Storage removal
  // after it fails, the file is unreachable (no row → no route serves it) and
  // the log names it for a clean-up.
  const { error: delErr } = await supabaseService.from(CLIENT_FILES_TABLE).delete().eq('id', row.id)
  if (delErr) {
    console.error('[client files delete]', delErr)
    return no('delete_failed', 500, WORDS.generic)
  }
  await removeClientFileObjects([row.path, ...(row.thumb_path ? [row.thumb_path] : [])], `file ${row.id} removed`)

  return NextResponse.json({ deleted: true, id: row.id })
}
