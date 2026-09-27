// lib/email-signature-edit-server.ts
//
// Server half of "whose signature does the Settings card edit" — shared by
// GET/PATCH /api/signature and POST /api/signature/photo so all three resolve
// the target the SAME way. Route files may only export HTTP handlers, hence
// its own module. The rule and its history: lib/email-signature-edit.ts.

import { NextResponse } from 'next/server'
import { isAdmin } from './auth'
import { supabaseService } from './supabase-service'
import { resolveEmailSigner } from './email-signature-resolve'
import { signatureEditTarget } from './email-signature-edit'

export type SignatureEditorUser = { id: string; role: string; location_id: string | null; is_active?: boolean | null; disabled_at?: string | null }

// Everything a signature read or write needs, from ONE resolution: the
// caller stands in as the "assignee", so the target is exactly the signer
// the preview shows.
export async function resolveSignatureEditContext(hubUser: SignatureEditorUser, requestedLocationId: string | null) {
  const locationId: string | null = isAdmin(hubUser.role)
    ? requestedLocationId || hubUser.location_id || null
    : hubUser.location_id || null
  if (!locationId) return null

  const { data: loc } = await supabaseService.from('locations').select('name').eq('id', locationId).maybeSingle()
  const locationName: string | null = (loc as any)?.name ?? null

  const resolved = await resolveEmailSigner({ locationId, locationName, assigneeUserId: hubUser.id })
  const target = signatureEditTarget({
    callerId: hubUser.id,
    callerRole: hubUser.role,
    signer: resolved.signer,
    reason: resolved.reason,
  })
  return { locationId, locationName, resolved, target }
}

// Shared by PATCH here and POST /api/signature/photo. null = go ahead.
export function checkEditTarget(
  ctx: Awaited<ReturnType<typeof resolveSignatureEditContext>>,
  targetUserId: unknown,
): NextResponse | null {
  if (!ctx) return NextResponse.json({ error: 'Open a location first.' }, { status: 400 })
  const { target, locationName } = ctx
  if (!target.targetId) {
    return NextResponse.json({ error: `No one at ${locationName || 'this location'} can sign emails yet.` }, { status: 409 })
  }
  if (typeof targetUserId !== 'string' || targetUserId !== target.targetId) {
    return NextResponse.json(
      { error: 'Whose signature this is has changed since the page loaded. Reload and check the name before saving.' },
      { status: 409 },
    )
  }
  if (!target.canEdit) {
    return NextResponse.json({ error: `Only ${target.targetName || 'that person'} or Bee Organized corporate can change this signature.` }, { status: 403 })
  }
  return null
}
