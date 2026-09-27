// app/api/signature/route.ts
//
//   GET /api/signature[?locationId=<uuid>]
//   → { person, links, preview: { html, text }, storageReady }
//
// Feeds the two Settings cards (your signature · your location's signature
// links) and every preview of {{signature}}. The preview is built by the SAME
// resolver and the SAME layout function a real send uses
// (resolveEmailSignature → buildSignatureHtml), as if a lead were assigned to
// the caller — so the preview can't drift from what clients receive. If the
// caller wouldn't sign (not active at that location), the preview shows who
// WOULD: exactly the send-time fallback.
//
// locationId: franchise users always get their own location; corporate
// (admin / super_admin) may pass one.

import { NextRequest, NextResponse } from 'next/server'
import { getHubUser, isAdmin } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import { buildSignatureHtml, buildSignatureText, signaturePhotoUrl } from '@/lib/email-signature'
import { loadLocationSignatureLinks, resolveEmailSignature } from '@/lib/email-signature-resolve'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const hubUser = await getHubUser()
  if (!hubUser) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const requested = req.nextUrl.searchParams.get('locationId')
  const locationId: string | null = isAdmin(hubUser.role) ? requested || hubUser.location_id || null : hubUser.location_id || null

  // The caller's own signature fields. Separate read: the columns may not exist
  // yet (migrations/email_signatures.sql) — then storageReady.person is false.
  let title: string | null = null
  let photoPath: string | null = null
  let personReady = true
  {
    const { data, error } = await supabaseService
      .from('hub_users')
      .select('signature_title, signature_photo_path')
      .eq('id', hubUser.id)
      .maybeSingle()
    if (error) personReady = false
    else {
      title = (data as any)?.signature_title ?? null
      photoPath = (data as any)?.signature_photo_path ?? null
    }
  }

  let locationName: string | null = null
  let linksReady = true
  let links = { website_url: null, facebook_url: null, instagram_url: null, linkedin_url: null } as Record<string, string | null>
  if (locationId) {
    const { data: loc } = await supabaseService.from('locations').select('name').eq('id', locationId).maybeSingle()
    locationName = (loc as any)?.name ?? null
    const probe = await supabaseService.from('locations').select('website_url').eq('id', locationId).maybeSingle()
    linksReady = !probe.error
    links = await loadLocationSignatureLinks(locationId)
  }

  const signature = locationId
    ? await resolveEmailSignature({ locationId, locationName, assigneeUserId: hubUser.id })
    : null

  return NextResponse.json({
    person: {
      name: hubUser.full_name ?? null,
      email: hubUser.email ?? null,
      mobile: hubUser.phone ?? null,
      title,
      photoPath,
      photoUrl: signaturePhotoUrl(photoPath),
    },
    location: { id: locationId, name: locationName },
    links,
    preview: signature ? { html: buildSignatureHtml(signature), text: buildSignatureText(signature) } : null,
    storageReady: { person: personReady, links: linksReady },
  })
}
