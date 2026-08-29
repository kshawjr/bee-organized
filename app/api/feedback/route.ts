// app/api/feedback/route.ts
//
// User-facing feedback / bug-report endpoints. Any authenticated hub_user can
// file an item and list their own items. Admin triage lives at
// /api/admin/feedback (separate route, fail-closed to super_admin/admin).
//
//   GET  /api/feedback — list the caller's own feedback_items, newest first.
//   POST /api/feedback — file a new bug report or feature request.
//
// Writes go through supabaseService (service role) so the insert isn't gated by
// RLS; reads are scoped to the session user_id in the query itself.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { buildSafeContext, insertFeedbackRow } from '@/lib/feedback-context'
import { withInternalFallback } from '@/lib/feedback-internal'
import { withRepliesFallback } from '@/lib/feedback-replies'

export const runtime = 'nodejs'

const VALID_TYPES = new Set(['bug', 'feature'])

// Roles allowed to read another user's items via ?user_id=. Matches
// ELEVATED_ROLES in /api/admin/feedback and ADMIN_ROLES in the attachment
// route — the corp tier that already sees all feedback through triage.
const ELEVATED_ROLES = ['super_admin', 'admin']

// GET — caller's own items, newest first.
//
// Elevated callers (super_admin/admin) may pass ?user_id= to read another
// user's list — the view-as "mine" tab rides this so impersonation previews
// the impersonated user's items instead of the impersonator's own. For every
// other caller the param is IGNORED, never honored (same stance as the
// ?location_id= override on /api/admin/feedback): a real user's read is
// always scoped to their own session user_id.
export async function GET(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // The caller's role is read on EVERY call now, not only when ?user_id= is
  // present: it decides both the override AND whether internal items are
  // filtered (issue 247 step 1). One single-row read by primary key — the same
  // lookup POST already does unconditionally.
  const { data: caller } = await supabase
    .from('hub_users')
    .select('role')
    .eq('id', user.id)
    .single()
  const isElevatedCaller = !!caller && ELEVATED_ROLES.includes(caller.role)

  let targetUserId = user.id
  const override = req.nextUrl.searchParams.get('user_id')
  if (override && override !== user.id && isElevatedCaller) targetUserId = override

  // The replies embed carries the conversation thread; it is dropped (and the
  // read retried without it) until migrations/feedback_replies.sql has run.
  const { data, error } = await withRepliesFallback<any[], any>(async (includeReplies) =>
    await withInternalFallback<any[]>(
    async (filterInternal) => {
      let query = supabaseService
        .from('feedback_items')
        .select(includeReplies
          ? '*, replies:feedback_replies ( id, author_id, author_role, body, created_at )'
          : '*')
        .eq('user_id', targetUserId)
        .order('created_at', { ascending: false })
      // Defence in depth. This list is ALREADY scoped to a single user_id, so
      // an internal item filed by engineering cannot surface here regardless.
      // The filter earns its place by making the invariant uniform — no
      // non-elevated caller receives an internal row from ANY endpoint — and by
      // keeping this tab in step with the owner screen if one of an owner's own
      // reports is ever reclassified internal. Without it the item would vanish
      // from "What you've told us" and linger here.
      if (filterInternal && !isElevatedCaller) query = query.eq('is_internal', false)
      return await query
    },
  ))

  if (error) {
    console.error('[feedback GET]', error)
    return NextResponse.json({ error: (error as { message?: string })?.message }, { status: 500 })
  }

  return NextResponse.json({ items: data || [] })
}

// POST — file a new item. status defaults to 'submitted'.
export async function POST(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // location_id is carried from the caller's hub_user record so admin triage
  // can group feedback by franchise without the client having to send it.
  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })

  let body: {
    type?: string
    title?: string
    description?: string
    attachments?: Array<{ path?: string; name?: string; size?: number; type?: string }>
    // Optional id-only record pointer (e.g. from "Report a problem with this
    // client"). Re-sanitized here — see buildSafeContext — so a tampered body
    // can never write a name/email/phone or an oversized blob into the column.
    context?: unknown
  }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const type = String(body.type || '').trim()
  if (!VALID_TYPES.has(type)) {
    return NextResponse.json({ error: 'type_must_be_bug_or_feature' }, { status: 400 })
  }

  const title = String(body.title || '').trim()
  if (title.length < 1 || title.length > 100) {
    return NextResponse.json({ error: 'title_must_be_1_100_chars' }, { status: 400 })
  }

  const description = String(body.description || '').trim()
  if (description.length < 1 || description.length > 2000) {
    return NextResponse.json({ error: 'description_must_be_1_2000_chars' }, { status: 400 })
  }

  // ─── Attachments (optional) ───────────────────────────────────
  // Each entry is metadata returned by /api/feedback/upload. We re-validate
  // here as defense in depth: cap at 5, require the storage path to live under
  // the caller's own user_id folder (prevents a tampered body from attaching
  // someone else's — or an arbitrary — object to this item).
  const rawAttachments = body.attachments
  let attachments: Array<{ path: string; name: string; size: number; type: string; uploaded_at: string }> = []
  if (rawAttachments !== undefined) {
    if (!Array.isArray(rawAttachments)) {
      return NextResponse.json({ error: 'attachments_must_be_array' }, { status: 400 })
    }
    if (rawAttachments.length > 5) {
      return NextResponse.json({ error: 'too_many_attachments_max_5' }, { status: 400 })
    }
    const now = new Date().toISOString()
    for (const a of rawAttachments) {
      const path = String(a?.path || '')
      if (!path || path.split('/')[0] !== user.id || path.includes('..')) {
        return NextResponse.json({ error: 'invalid_attachment_path' }, { status: 400 })
      }
      attachments.push({
        path,
        name: String(a?.name || 'file').slice(0, 200),
        size: Number.isFinite(a?.size) ? Number(a?.size) : 0,
        type: String(a?.type || 'application/octet-stream').slice(0, 120),
        uploaded_at: now,
      })
    }
  }

  // Re-derive the record context server-side (id-only whitelist). null when
  // absent or nothing survives → no column written.
  const context = buildSafeContext(body.context)

  const baseRow = {
    user_id: user.id,
    location_id: hubUser.location_id || null,
    type,
    title,
    description,
    status: 'submitted',
    attachments,
  }

  // Insert with context attached — but if the `context` column hasn't been
  // migrated yet (the DDL is HELD; Kevin runs it), fail SOFT: retry without it
  // so the report still files rather than 500ing. Real errors still surface.
  const { data: row, error, contextDropped } = await insertFeedbackRow(
    async (r) => await supabaseService.from('feedback_items').insert(r).select('*').single(),
    baseRow,
    context,
  )

  if (error || !row) {
    console.error('[feedback POST]', error)
    return NextResponse.json({ error: (error as { message?: string })?.message || 'insert_failed' }, { status: 500 })
  }

  if (contextDropped) {
    // Non-fatal breadcrumb: the item filed, just without its record pointer.
    console.warn('[feedback POST] context column missing — filed without record context (migration pending)')
  }

  return NextResponse.json(row, { status: 201 })
}
