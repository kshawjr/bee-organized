// app/api/feedback/[id]/route.ts
//
// The SUBMITTER'S OWN DOOR on their own report.
//
//   PATCH  /api/feedback/[id] — change the title and/or the description, while
//                               the team has not replied.
//   DELETE /api/feedback/[id] — take the report back. A real delete.
//
// Entry ede746a9 asked for both, in these words: "I submitted a couple because
// I thought they were bugs, but after taking a minute or two navigating around
// the CRM, I was just looking in the wrong place."
//
// WHY THIS IS NOT ANOTHER BRANCH ON /api/admin/feedback/[id]. That route is
// TRIAGE's door and it is built around triage's job: it is open to any elevated
// caller and to owner/manager for their whole LOCATION, it decides who gets
// emailed, and it seeds the What's new draft. Every one of those is wrong here.
// This door is open to ONE person — the one whose name is on the report — it
// sends nothing, and it seeds nothing. One door per voice, the same reason
// POST /api/feedback/[id]/replies is its own route rather than a flag on the
// triage PATCH.
//
// THE OWNERSHIP TEST IS user_id, NEVER location_id. An owner and a manager at
// the same franchise read each other's reports on the same screen; neither may
// edit or delete the other's. A location test would let them, and a location
// test is what "prove the route refuses it" is really asking about — so the
// comparison here is against the caller's own id and nothing else, for a
// caller of ANY role. There is no elevated override: a super_admin editing an
// owner's report would be putting words in their mouth, and admins already have
// the triage door for everything they legitimately do.
//
// ─── WHAT A DELETE TAKES WITH IT ──────────────────────────────────────
// Named here because a real delete is only safe if the list is complete:
//
//   · feedback_replies — ON DELETE CASCADE. The whole conversation goes. This
//     is correct: it is the owner's own thread, and a thread with no report is
//     not a record of anything.
//   · help_release_items.feedback_item_id — ON DELETE SET NULL, so a What's new
//     line SURVIVES the entry it was seeded from. That is right for a line
//     someone has edited or published — those are Kevin's words, already out —
//     and wrong for an UNEDITED line in the OPEN DRAFT, which is the owner's
//     own title verbatim, never yet shown to anyone. Those are removed here,
//     softly (deleted_at), before the entry goes. See sweepUnpublishedSeedLine.
//   · Storage objects in feedback-attachments — no FK, no cascade, nothing
//     else points at them. Removed here explicitly, or they outlive the report
//     forever with nobody able to find them.
//   · reply_seen_at, the analysis cache, the cluster it sat in, the daily
//     brief, the unopened-reply alert, system-health's open count — ALL of
//     them derive from the live rows on every read. Nothing is stored, so
//     nothing dangles: the next read simply sees one fewer item, and a cluster
//     that drops to a single member stops being a cluster at all.
//   · notification_log keeps the rows for emails we really did send. No
//     feedback id is stored there, and a sent email is a fact about the past
//     that a later delete does not undo.
//   · feedback_deletions gains one audit line — see the migration header, and
//     the note on writeTombstone below.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { withInternalFallback, isInternalItem } from '@/lib/feedback-internal'
import { withRepliesFallback, type FeedbackReplyRow } from '@/lib/feedback-replies'
import {
  EDIT_LOCKED, feedbackEditLocked,
  MAX_FEEDBACK_TITLE_CHARS, MAX_FEEDBACK_DESCRIPTION_CHARS,
} from '@/lib/feedback-edit'

export const runtime = 'nodejs'

const ELEVATED_ROLES = ['super_admin', 'admin']
const BUCKET = 'feedback-attachments'

// Everything the two handlers need about the target: ownership, the internal
// flag, and enough of the conversation for feedbackEditLocked to be answerable.
const TARGET_COLS =
  'id, user_id, location_id, type, title, status, created_at, attachments, admin_response, admin_response_at'

type Target = {
  id: string
  user_id: string
  location_id: string | null
  type: string | null
  title: string | null
  status: string | null
  created_at: string | null
  attachments?: unknown
  admin_response?: string | null
  admin_response_at?: string | null
  is_internal?: unknown
  replies?: FeedbackReplyRow[] | null
}

// Load the row with its thread. Two fallbacks stacked, both established
// elsewhere in this feature: the is_internal column and the feedback_replies
// table each predate their migrations in some environments, and a read that
// 500s because of one of them would take edit and delete down with it.
async function loadTarget(id: string): Promise<Target | null> {
  const { data } = await withRepliesFallback<any, any>(async (includeReplies) =>
    await withInternalFallback<any>(async (withInternal) =>
      await supabaseService
        .from('feedback_items')
        .select(
          `${TARGET_COLS}${withInternal ? ', is_internal' : ''}` +
          (includeReplies ? ', replies:feedback_replies ( id, author_id, author_role, body, created_at )' : ''),
        )
        .eq('id', id)
        .single(),
    ),
  )
  return (data as Target) || null
}

// The guard both handlers run, in the order the rest of this feature runs it.
// Returns either the target or the response to send instead.
async function resolveOwnTarget(id: string): Promise<
  { ok: true; target: Target; callerId: string } | { ok: false; res: NextResponse }
> {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, res: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role')
    .eq('id', user.id)
    .single()
  if (!caller) return { ok: false, res: NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 }) }

  if (!id) return { ok: false, res: NextResponse.json({ error: 'id_required' }, { status: 400 }) }

  const target = await loadTarget(id)
  if (!target) return { ok: false, res: NextResponse.json({ error: 'not_found' }, { status: 404 }) }

  // An internal item does not exist for a non-elevated caller — 404, never 403,
  // the same stance as the replies POST and the triage PATCH: an unknown id and
  // an internal id must be indistinguishable.
  if (!ELEVATED_ROLES.includes(caller.role) && isInternalItem(target)) {
    return { ok: false, res: NextResponse.json({ error: 'not_found' }, { status: 404 }) }
  }

  // THE WHOLE WALL, in one line. Not the location — see the header.
  if (target.user_id !== caller.id) {
    return { ok: false, res: NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
  }

  return { ok: true, target, callerId: caller.id }
}

// ─── PATCH — change your own words ────────────────────────────────────
//
// TITLE AND DESCRIPTION ONLY. Not type: reclassifying is triage's job and the
// triage PATCH already refuses it to everyone below admin, so accepting it here
// would be a second door with different rules on the same field. Not status,
// not attachments: neither was asked for, and an owner moving their own report
// to Fixed is the exact confusion the owner screen was split off to end.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const gate = await resolveOwnTarget(params.id)
  if (!gate.ok) return gate.res
  const { target } = gate

  // THE LOCK, server-side. The screen hides the button once the team has
  // replied; this is what makes that true rather than decorative.
  if (feedbackEditLocked(target)) {
    return NextResponse.json({ error: EDIT_LOCKED }, { status: 409 })
  }

  let body: { title?: unknown; description?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const patch: Record<string, string> = {}

  if (body.title !== undefined) {
    const title = String(body.title ?? '').trim()
    if (title.length < 1 || title.length > MAX_FEEDBACK_TITLE_CHARS) {
      return NextResponse.json({ error: 'title_must_be_1_100_chars' }, { status: 400 })
    }
    patch.title = title
  }

  if (body.description !== undefined) {
    const description = String(body.description ?? '').trim()
    if (description.length < 1 || description.length > MAX_FEEDBACK_DESCRIPTION_CHARS) {
      return NextResponse.json({ error: 'description_must_be_1_2000_chars' }, { status: 400 })
    }
    patch.description = description
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no_fields_to_update' }, { status: 400 })
  }

  // The user_id predicate is REDUNDANT — resolveOwnTarget already proved it —
  // and it stays. It costs nothing and it means the write itself cannot touch
  // another person's row even if the guard above is ever refactored wrong.
  const { data: row, error } = await supabaseService
    .from('feedback_items')
    .update(patch)
    .eq('id', target.id)
    .eq('user_id', target.user_id)
    .select('*')
    .single()

  if (error || !row) {
    console.error('[feedback PATCH]', error)
    return NextResponse.json(
      { error: (error as { message?: string })?.message || 'update_failed' },
      { status: 500 },
    )
  }

  return NextResponse.json(row)
}

// ─── DELETE — take it back ────────────────────────────────────────────
//
// NO REPLY GATE. Kevin's ruling, and the right one: withdrawing a report is
// ending a conversation, not rewriting one.
//
// ORDER MATTERS, and it is: sweep the unpublished seed line → remember what the
// row said → delete the row → clean the bucket → write the tombstone. The row
// goes in the middle because everything before it needs the row to still be
// there, and everything after it is cleanup that must NOT be able to fail the
// delete the owner already asked for.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const gate = await resolveOwnTarget(params.id)
  if (!gate.ok) return gate.res
  const { target, callerId } = gate

  // Before the FK nulls itself out and we can no longer find the line.
  await sweepUnpublishedSeedLine(target.id, callerId)

  const hadReply = !!String(target.admin_response ?? '').trim() ||
    (Array.isArray(target.replies) && target.replies.some(r => r?.author_role === 'team'))

  const paths = attachmentPaths(target.attachments)

  const { error } = await supabaseService
    .from('feedback_items')
    .delete()
    .eq('id', target.id)
    // Redundant, kept — see the PATCH note.
    .eq('user_id', target.user_id)

  if (error) {
    console.error('[feedback DELETE]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // ── from here down, nothing may fail the request ──
  // The report is gone. That is what was asked for and it has happened; a 500
  // now would tell the owner their delete failed when it did not, and they
  // would press the button again on an id that no longer exists.
  await removeAttachments(paths)
  await writeTombstone(target, callerId, hadReply)

  return NextResponse.json({ deleted: true, id: target.id })
}

// ── the What's new line ───────────────────────────────────────────────
//
// A seeded line is provenance only — nothing on it is ever written back to the
// entry — so the FK's ON DELETE SET NULL is already safe. This exists for the
// one case where "safe" is not "right": an UNEDITED line in the OPEN DRAFT is
// the owner's own title, verbatim, seeded automatically when we marked their
// report Fixed. It has never been shown to an owner and never posted to Slack
// (edited_at NULL is exactly what withholds it). If the person whose words
// those are withdraws the report, leaving their sentence sitting in next
// Thursday's note with no trace of where it came from is the wrong outcome.
//
// WHAT IS LEFT ALONE, deliberately:
//   · a PUBLISHED line — it has gone out. It is Kevin's edited words in a note
//     owners have already read, and unpublishing history is not what a delete
//     button on someone's own report means.
//   · an EDITED line in the draft (edited_at set) — Kevin rewrote it. It is his
//     sentence now, and it stays; it simply loses its source panel when the FK
//     nulls.
//
// Soft, not hard: help_release_items has its own deleted_at and its own
// meaning for it ("Kevin removed this line"), and the unique index on
// feedback_item_id counts deleted rows on purpose. Using the existing mechanism
// keeps that intact. NEVER FATAL — a failure here must not stop a delete.
async function sweepUnpublishedSeedLine(itemId: string, byUserId: string): Promise<void> {
  try {
    const { data: draft } = await supabaseService
      .from('help_releases')
      .select('id')
      .eq('status', 'draft')
      .limit(1)
      .maybeSingle()
    if (!draft?.id) return

    const { error } = await supabaseService
      .from('help_release_items')
      .update({ deleted_at: new Date().toISOString(), updated_by: byUserId })
      .eq('release_id', draft.id)
      .eq('feedback_item_id', itemId)
      .is('edited_at', null)
      .is('deleted_at', null)
    if (error) {
      console.warn('[feedback DELETE] seed-line sweep failed:', (error as { message?: string })?.message)
    }
  } catch (err: any) {
    console.warn('[feedback DELETE] seed-line sweep threw:', err?.message || err)
  }
}

// ── the bucket ────────────────────────────────────────────────────────
// The attachments column is the ONLY pointer at these objects, so once the row
// is gone nothing in the system can name them again. Removing them here is the
// difference between a delete and a delete that leaves the screenshots behind.
//
// The paths are re-checked against the owner's own folder before we remove
// anything — the same check POST /api/feedback makes on the way in. A row whose
// column was somehow written with a foreign path must not turn a delete into a
// way to erase someone else's file.
function attachmentPaths(attachments: unknown): string[] {
  if (!Array.isArray(attachments)) return []
  return attachments
    .map(a => String((a as { path?: unknown })?.path ?? ''))
    .filter(p => !!p && !p.includes('..'))
}

async function removeAttachments(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  try {
    const { error } = await supabaseService.storage.from(BUCKET).remove(paths)
    if (error) {
      console.warn('[feedback DELETE] attachment cleanup failed:', error.message, paths)
    }
  } catch (err: any) {
    console.warn('[feedback DELETE] attachment cleanup threw:', err?.message || err)
  }
}

// ── the trace ─────────────────────────────────────────────────────────
// One audit line so the report does not vanish from the triage side with
// nothing to say it ever existed. See migrations/feedback_deletions.sql for
// the shape and for why this is not a soft delete.
//
// NEVER FATAL, and the log line is the fallback: until the migration runs, a
// delete still works and leaves its trace in the Vercel log instead of a row.
async function writeTombstone(target: Target, byUserId: string, hadReply: boolean): Promise<void> {
  // The log line obeys the same rule as the row: it names the FACT, never the
  // words. Putting the title in here would just move their sentence from a
  // table Kevin controls into a Vercel log he cannot edit.
  const trace =
    `[feedback DELETE] ${target.type ?? 'item'} (${target.id}) ` +
    `withdrawn by ${byUserId}; status=${target.status ?? '?'} had_reply=${hadReply}`
  try {
    const { error } = await supabaseService.from('feedback_deletions').insert({
      feedback_item_id: target.id,
      user_id: target.user_id,
      location_id: target.location_id,
      type: target.type,
      // NO TITLE. Kevin's ruling — their words go, the fact of it stays.
      status: target.status,
      item_created_at: target.created_at,
      had_reply: hadReply,
      deleted_by: byUserId,
    })
    if (error) {
      console.warn(`${trace} — tombstone not recorded:`, (error as { message?: string })?.message)
      return
    }
    console.info(trace)
  } catch (err: any) {
    console.warn(`${trace} — tombstone threw:`, err?.message || err)
  }
}
