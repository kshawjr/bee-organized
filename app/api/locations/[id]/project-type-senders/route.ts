// app/api/locations/[id]/project-type-senders/route.ts
//
// Per-project-type drip SENDER routing config for one location.
//
// GET    /api/locations/:id/project-type-senders
//   → { enabled, base_sender_email, base_sender_domain, project_types,
//       assignments:[{ project_type, sender_name, sender_email, ...,
//       domain_warning }], people:[{ id, name, email, role, domain_warning }] }
//   Assignable people are read LIVE from hub_users (owner/manager) for the
//   picker; domain_warning flags a sender whose email domain differs from the
//   location's base sender (likely not verified → won't deliver).
//
// PATCH  Body: { enabled: boolean } — flip the split master toggle.
//
// POST   Body: { sender_name, sender_email, sender_reply_to?, source_user_id?,
//                project_types: string[] } — assign a sender to a set of project
//   types (upsert, one-per-type). Reassigning a type moves it to this sender.
//
// DELETE Body: { project_types: string[] } — unassign types → base sender.
//
// Auth: super_admin/admin (any location) or the franchise OWNER of THIS
// location ONLY — enforced server-side on EVERY verb (incl. GET). A MANAGER or
// lite_user is rejected even on a direct API hit. Same predicate as the B1 Lead
// Notification Recipients routes.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { notificationRecipientsManageableServer } from '@/lib/notification-access'
import {
  getSenderConfig,
  setSplitEnabled,
  assignSenderToTypes,
  unassignTypes,
} from '@/lib/project-type-senders'

export const runtime = 'nodejs'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

async function authForLocation(locId: string) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'unauthorized', status: 401 as const }

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return { error: 'no_hub_user_profile', status: 403 as const }

  if (!notificationRecipientsManageableServer(hubUser.role, hubUser.location_id, locId)) {
    // Managers + lite_users + owners of other locations all land here.
    return { error: 'forbidden', status: 403 as const }
  }
  return { hubUser }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await authForLocation(params.id)
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  try {
    const data = await getSenderConfig(params.id)
    return NextResponse.json(data)
  } catch (e: any) {
    console.error('[project-type-senders GET]', e?.message || e)
    return NextResponse.json({ error: 'load_failed' }, { status: 500 })
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await authForLocation(params.id)
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (typeof body?.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
  }
  try {
    await setSplitEnabled(params.id, body.enabled)
    return NextResponse.json({ ok: true, enabled: body.enabled })
  } catch (e: any) {
    console.error('[project-type-senders PATCH]', e?.message || e)
    return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await authForLocation(params.id)
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const senderName = typeof body?.sender_name === 'string' ? body.sender_name.trim() : ''
  const senderEmail = typeof body?.sender_email === 'string' ? body.sender_email.trim() : ''
  const senderReplyTo =
    typeof body?.sender_reply_to === 'string' && body.sender_reply_to.trim()
      ? body.sender_reply_to.trim()
      : null
  const sourceUserId =
    typeof body?.source_user_id === 'string' && body.source_user_id ? body.source_user_id : null
  const projectTypes: string[] = Array.isArray(body?.project_types)
    ? body.project_types.filter((t: unknown) => typeof t === 'string' && t.trim()).map((t: string) => t.trim())
    : []

  if (!senderName) {
    return NextResponse.json({ error: 'sender_name is required' }, { status: 400 })
  }
  if (!EMAIL_RE.test(senderEmail)) {
    return NextResponse.json({ error: 'sender_email must be a valid email' }, { status: 400 })
  }
  if (projectTypes.length === 0) {
    return NextResponse.json({ error: 'project_types must be a non-empty array' }, { status: 400 })
  }

  try {
    await assignSenderToTypes(
      params.id,
      { sender_name: senderName, sender_email: senderEmail, sender_reply_to: senderReplyTo, source_user_id: sourceUserId },
      projectTypes,
    )
    const data = await getSenderConfig(params.id)
    return NextResponse.json(data)
  } catch (e: any) {
    console.error('[project-type-senders POST]', e?.message || e)
    return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await authForLocation(params.id)
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const projectTypes: string[] = Array.isArray(body?.project_types)
    ? body.project_types.filter((t: unknown) => typeof t === 'string' && t.trim()).map((t: string) => t.trim())
    : []
  if (projectTypes.length === 0) {
    return NextResponse.json({ error: 'project_types must be a non-empty array' }, { status: 400 })
  }
  try {
    await unassignTypes(params.id, projectTypes)
    const data = await getSenderConfig(params.id)
    return NextResponse.json(data)
  } catch (e: any) {
    console.error('[project-type-senders DELETE]', e?.message || e)
    return NextResponse.json({ error: 'delete_failed' }, { status: 500 })
  }
}
