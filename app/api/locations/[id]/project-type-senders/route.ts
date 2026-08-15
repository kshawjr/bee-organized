// app/api/locations/[id]/project-type-senders/route.ts
//
// Per-project-type drip SENDER routing config for one location.
//
// TWO QUESTIONS PER JOB TYPE (issue 296), and one verb each:
//
//   WHO HANDLES IT    POST — a person. Drives the lead assignment.
//   WHAT IT SENDS AS  PUT  — that person's identity, or a typed one.
//
// They are independent facts and neither verb touches the other's columns. A
// combined writer is what let sender_reply_to be silently nulled by every save
// for the whole of its life; see lib/project-type-senders.ts.
//
// GET    /api/locations/:id/project-type-senders
//   → { base_sender_email, base_sender_domain, project_types,
//       project_type_groups, assignments:[{ project_type, sender_name,
//       sender_email, sender_reply_to, sender_is_custom, source_user_id,
//       domain_warning }],
//       people:[{ id, name, email, role, domain_warning }] }
//   Assignable people are read LIVE from hub_users (owner/manager) for the
//   picker; domain_warning flags a sender whose email domain differs from the
//   location's base sender (likely not verified → won't deliver).
//
// POST   Body: { source_user_id, project_types: string[] } — set who handles a
//   set of project types (upsert, one-per-type). Reassigning a type moves it to
//   this person. source_user_id is REQUIRED (issue 246 step 2): a handler is a
//   person, and it is validated against hub_users at THIS location with a
//   pickable role.
//   The body no longer carries sender_name/sender_email (issue 296) — person
//   mode reads them from the handler's own row, so a client cannot persist a
//   stale copy or send as an address that is not theirs. A type already sending
//   as a typed address KEEPS it; changing the handler is not a statement about
//   the From line.
//
// PUT    Body: { project_type, sender_is_custom, sender_name?, sender_email?,
//                sender_reply_to? } — set what ONE type sends as.
//   sender_is_custom=false → back to the handler's own identity (re-read from
//   hub_users; reply-to clears to the location default).
//   sender_is_custom=true  → sender_name + sender_email REQUIRED, sender_reply_to
//   optional. All addresses go through EMAIL_RE — including sender_reply_to,
//   which had a validator that only trimmed until issue 296.
//   Requires an existing handler row: a typed sender is stored ON that row, so a
//   type parked on "The location owner" has nowhere to keep one → 409.
//
// DELETE Body: { project_types: string[] } — unassign types → base sender.
//
// THERE IS NO MASTER TOGGLE, and no PATCH. Both went with
// locations.split_senders_enabled in issue 246 step 2: "no handler row for this
// type" IS the off state, said per type. Issue 246 step 3 deleted the last
// caller of the retired PATCH. The PUT above is not its return: it sets one
// row's sending identity, not a per-location flag.
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
  getPickableHandler,
  setHandlerForTypes,
  setSenderIdentityForType,
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

// PATCH retired with the split_senders_enabled flag it flipped (issue 246
// step 2). "No handler row" is the off state, so there is no master toggle
// left to set — clearing a type's handler is a DELETE of that type.

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

  const sourceUserId =
    typeof body?.source_user_id === 'string' && body.source_user_id ? body.source_user_id : null
  const projectTypes: string[] = Array.isArray(body?.project_types)
    ? body.project_types.filter((t: unknown) => typeof t === 'string' && t.trim()).map((t: string) => t.trim())
    : []

  // issue 246 step 2 — a handler must be a PERSON. Without this the DB's NOT
  // NULL would still catch it, but as an opaque 500 rather than something the
  // UI can act on.
  if (!sourceUserId) {
    return NextResponse.json(
      { error: 'source_user_id is required — a handler must be a person' },
      { status: 400 },
    )
  }
  if (projectTypes.length === 0) {
    return NextResponse.json({ error: 'project_types must be a non-empty array' }, { status: 400 })
  }

  try {
    // Name/email come from the handler's own hub_users row, never the request
    // (issue 296). This also rejects a person at another location or in a role
    // the picker does not offer.
    const handler = await getPickableHandler(params.id, sourceUserId)
    if (!handler) {
      return NextResponse.json(
        { error: 'source_user_id is not a person who can handle a job type here' },
        { status: 400 },
      )
    }
    await setHandlerForTypes(params.id, handler, projectTypes)
    const data = await getSenderConfig(params.id)
    return NextResponse.json(data)
  } catch (e: any) {
    const msg = String(e?.message || e)
    console.error('[project-type-senders POST]', msg)
    // An unknown project type is the caller's mistake, not a server fault —
    // setHandlerForTypes rejects it rather than storing an unmatchable row.
    if (msg.includes('unknown project type')) {
      return NextResponse.json({ error: 'unknown_project_type' }, { status: 400 })
    }
    return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  }
}

// WHAT ONE JOB TYPE SENDS AS. Never touches source_user_id — who handles the
// type is POST's business, and a row must already exist for this to have
// somewhere to land.
export async function PUT(
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

  const projectType = typeof body?.project_type === 'string' ? body.project_type.trim() : ''
  if (!projectType) {
    return NextResponse.json({ error: 'project_type is required' }, { status: 400 })
  }
  if (typeof body?.sender_is_custom !== 'boolean') {
    return NextResponse.json({ error: 'sender_is_custom must be a boolean' }, { status: 400 })
  }

  let identity: Parameters<typeof setSenderIdentityForType>[2]
  if (body.sender_is_custom) {
    const senderName = typeof body?.sender_name === 'string' ? body.sender_name.trim() : ''
    const senderEmail = typeof body?.sender_email === 'string' ? body.sender_email.trim() : ''
    const senderReplyTo =
      typeof body?.sender_reply_to === 'string' && body.sender_reply_to.trim()
        ? body.sender_reply_to.trim()
        : null

    if (!senderName) {
      return NextResponse.json({ error: 'sender_name is required' }, { status: 400 })
    }
    if (!EMAIL_RE.test(senderEmail)) {
      return NextResponse.json({ error: 'sender_email must be a valid email' }, { status: 400 })
    }
    // issue 296 — sender_reply_to was only ever trimmed, never format-checked,
    // which was harmless while nothing could write it. A malformed reply-to now
    // reaches Resend and fails the send at delivery time, blaming the drip for
    // a typo made in settings. Same EMAIL_RE as every other address here.
    if (senderReplyTo !== null && !EMAIL_RE.test(senderReplyTo)) {
      return NextResponse.json({ error: 'sender_reply_to must be a valid email' }, { status: 400 })
    }
    identity = {
      sender_is_custom: true,
      sender_name: senderName,
      sender_email: senderEmail,
      sender_reply_to: senderReplyTo,
    }
  } else {
    identity = { sender_is_custom: false }
  }

  try {
    await setSenderIdentityForType(params.id, projectType, identity)
    const data = await getSenderConfig(params.id)
    return NextResponse.json(data)
  } catch (e: any) {
    const msg = String(e?.message || e)
    console.error('[project-type-senders PUT]', msg)
    if (msg.includes('unknown project type')) {
      return NextResponse.json({ error: 'unknown_project_type' }, { status: 400 })
    }
    // No handler row yet — the UI should not have offered the control, so this
    // is a state mismatch rather than bad input.
    if (msg.includes('no handler for')) {
      return NextResponse.json({ error: 'no_handler_for_type' }, { status: 409 })
    }
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
