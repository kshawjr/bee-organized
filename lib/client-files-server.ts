// lib/client-files-server.ts
// ─────────────────────────────────────────────────────────────
// The server half of client files: who is asking, which client, and the one
// place that removes a client's files from Storage. Rules and constants are
// in lib/client-files.ts; read its header first.
//
// Everything here goes through the service-role client. The bucket has no
// Storage policy of any kind, so a signed-in browser talking to Supabase
// directly can neither list, read, add nor remove an object in it. These
// routes are the only door.
// ─────────────────────────────────────────────────────────────
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { CLIENT_FILES_BUCKET, CLIENT_FILES_TABLE, canSeeClientFiles, isMissingFilesTable } from '@/lib/client-files'

export type FilesCaller = {
  id: string
  role: string
  location_id: string | null
  first_name?: string | null
  last_name?: string | null
  full_name?: string | null
}

export type FilesLead = { id: string; location_uuid: string | null; is_junk: boolean | null }

const no = (error: string, status: number, detail?: string) =>
  NextResponse.json(detail ? { error, detail } : { error }, { status })

/** The signed-in person, or the response that turns them away. */
export async function filesCaller(): Promise<{ caller: FilesCaller } | { refuse: NextResponse }> {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { refuse: no('unauthorized', 401) }
  const { data: hubUser, error } = await supabase
    .from('hub_users')
    .select('id, role, location_id, first_name, last_name, full_name')
    .eq('id', user.id)
    .single()
  if (error || !hubUser) return { refuse: no('no_hub_user_profile', 403) }
  return { caller: hubUser as FilesCaller }
}

/**
 * The client, read fresh, and only if this person may see them. Where the
 * client is filed is read NOW, on every request: a file's access is never
 * remembered from when it was added.
 */
export async function leadForFiles(
  caller: FilesCaller,
  leadId: string,
): Promise<{ lead: FilesLead } | { refuse: NextResponse }> {
  const { data: lead, error } = await supabaseService
    .from('leads')
    .select('id, location_uuid, is_junk')
    .eq('id', leadId)
    .maybeSingle()
  if (error || !lead) return { refuse: no('client_not_found', 404) }
  if (!canSeeClientFiles(caller, lead)) return { refuse: no('forbidden_wrong_location', 403) }
  return { lead: lead as FilesLead }
}

export function callerLabel(caller: FilesCaller): string {
  const name = caller.full_name || [caller.first_name, caller.last_name].filter(Boolean).join(' ').trim()
  return name || 'Someone'
}

/**
 * Is the bucket there, and is it PRIVATE? Asked before every upload. If
 * anyone ever flips it to public in the Supabase dashboard, uploads stop here
 * rather than a client's photos landing somewhere the whole internet can read.
 */
export async function bucketProblem(): Promise<null | 'missing' | 'public'> {
  const { data, error } = await supabaseService.storage.getBucket(CLIENT_FILES_BUCKET)
  if (error || !data) return 'missing'
  return data.public === false ? null : 'public'
}

/**
 * Every Storage object a client has, by what the table says. Read BEFORE the
 * client row is deleted (the delete takes the rows with it).
 */
export async function clientFileObjectPaths(leadId: string): Promise<string[]> {
  const { data, error } = await supabaseService
    .from(CLIENT_FILES_TABLE)
    .select('path, thumb_path')
    .eq('lead_id', leadId)
  if (error) {
    // No table yet = no files yet. Anything else: say so, and carry on with
    // none — the caller is deleting a client and must not be stopped by this.
    if (!isMissingFilesTable(error)) console.error('[client files] could not list a client’s files before delete', leadId, error.message)
    return []
  }
  const out: string[] = []
  for (const row of (data || []) as { path: string | null; thumb_path: string | null }[]) {
    if (row.path) out.push(row.path)
    if (row.thumb_path) out.push(row.thumb_path)
  }
  return out
}

/**
 * Remove objects from the bucket. Never throws: it is called after the thing
 * that mattered (a row delete) has already happened, and a leftover object
 * must be shouted about, not turned into a failed request.
 */
export async function removeClientFileObjects(paths: string[], why: string): Promise<boolean> {
  if (paths.length === 0) return true
  try {
    const { error } = await supabaseService.storage.from(CLIENT_FILES_BUCKET).remove(paths)
    if (error) {
      console.error(`[client files] LEFT BEHIND in Storage (${why}):`, error.message, paths)
      return false
    }
    return true
  } catch (err: any) {
    console.error(`[client files] LEFT BEHIND in Storage (${why}):`, err?.message || err, paths)
    return false
  }
}
