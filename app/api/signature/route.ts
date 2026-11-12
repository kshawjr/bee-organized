// app/api/signature/route.ts
//
//   GET   /api/signature[?locationId=<uuid>]
//         → { target, person, location, links, hasLinks, preview, storageReady }
//   PATCH /api/signature
//         { locationId?, targetUserId, signature_title?, signature_photo_path?,
//           signature_linkedin_url? }
//
// signature_linkedin_url (2026-10-31, migrations/signature_linkedin.sql) is
// the signer's OWN LinkedIn, used only where the location has none
// (lib/email-signature-resolve.ts linkedinFor). Same target rule as the title
// and photo: your own, or — for super_admin/admin — the signer you are
// viewing. Before the migration runs, storageReady.personLinkedin is false
// and the screen doesn't offer it.
//
// The Settings signature card reads and writes ONLY through here, and both
// directions resolve WHOSE signature it is the same way — resolveEmailSigner
// with the caller standing in as the assignee, i.e. exactly the person the
// preview shows (lib/email-signature-edit.ts has the rule and the bug it
// closes). So:
//
//   · an owner/manager at their own location → their own signature
//   · super_admin/admin viewing a location   → that location's signer
//                                              (Kevin at Southwest Austin →
//                                              Raluca Sharma), editable
//   · anyone else whose signer is not them   → read-only
//
// PATCH re-derives the target and refuses unless it is the one the card
// showed (targetUserId) — the card can never save onto a person it did not
// name, even if the location's owner changed while the page was open.
//
// The preview is built by the same resolver and layout a real send uses.
// locationId: franchise users always get their own location; corporate may
// pass one.

import { NextRequest, NextResponse } from 'next/server'
import { getHubUser } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import {
  buildSignatureHtml,
  buildSignatureText,
  safeHttpUrl,
  isValidSignaturePhotoPath,
  signaturePhotoUrl,
  SIGNATURE_PHOTO_BUCKET,
} from '@/lib/email-signature'
import { loadLocationSignatureLinks, loadPersonLinkedin } from '@/lib/email-signature-resolve'
import {
  locationHasSignatureLinks,
  normalizeSignatureTitle,
  signatureCardExplainer,
  signatureCardHeading,
} from '@/lib/email-signature-edit'
import { checkEditTarget, resolveSignatureEditContext, type SignatureEditorUser } from '@/lib/email-signature-edit-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const hubUser = (await getHubUser()) as SignatureEditorUser | null
  if (!hubUser) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const ctx = await resolveSignatureEditContext(hubUser, req.nextUrl.searchParams.get('locationId'))
  if (!ctx) {
    return NextResponse.json({ target: null, person: null, location: null, links: null, hasLinks: false, preview: null, storageReady: { person: true, links: true } })
  }
  const { locationId, locationName, resolved, target } = ctx

  // Storage probes: the columns arrive with migrations/email_signatures.sql.
  const personProbe = await supabaseService.from('hub_users').select('signature_title').eq('id', hubUser.id).maybeSingle()
  const linksProbe = await supabaseService.from('locations').select('website_url').eq('id', locationId).maybeSingle()
  const links = await loadLocationSignatureLinks(locationId)

  const signer = resolved.signer
  return NextResponse.json({
    target: {
      ...target,
      heading: signatureCardHeading(target, locationName),
      explainer: signatureCardExplainer(target, locationName),
    },
    // The TARGET's fields — never the caller's, unless the caller is the target.
    person: signer
      ? {
          id: signer.id,
          name: signer.full_name ?? null,
          email: signer.email ?? null,
          mobile: signer.phone ?? null,
          title: signer.signature_title ?? null,
          photoPath: signer.signature_photo_path ?? null,
          photoUrl: signaturePhotoUrl(signer.signature_photo_path),
          linkedinUrl: signer.signature_linkedin_url ?? null,
        }
      : null,
    location: { id: locationId, name: locationName },
    links,
    hasLinks: locationHasSignatureLinks(links),
    preview: { html: buildSignatureHtml(resolved.signature), text: buildSignatureText(resolved.signature) },
    storageReady: {
      person: !personProbe.error,
      links: !linksProbe.error,
      personLinkedin: signer ? (await loadPersonLinkedin(signer.id)).ready : false,
    },
  })
}

export async function PATCH(req: NextRequest) {
  const hubUser = (await getHubUser()) as SignatureEditorUser | null
  if (!hubUser) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (hubUser.is_active === false || hubUser.disabled_at) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as {
    locationId?: string
    targetUserId?: string
    signature_title?: string
    signature_photo_path?: string
    signature_linkedin_url?: string
  }

  const ctx = await resolveSignatureEditContext(hubUser, typeof body.locationId === 'string' ? body.locationId : null)
  const guard = checkEditTarget(ctx, body.targetUserId)
  if (guard) return guard
  const targetId = ctx!.target.targetId!

  const patch: Record<string, any> = { updated_at: new Date().toISOString() }
  if (typeof body.signature_title === 'string') {
    const t = normalizeSignatureTitle(body.signature_title)
    if (!t.ok) return NextResponse.json({ error: t.error }, { status: 400 })
    patch.signature_title = t.value
  }
  if (typeof body.signature_photo_path === 'string') {
    const p = body.signature_photo_path.trim()
    if (!p) {
      patch.signature_photo_path = null
    } else {
      // Must be a path /api/signature/photo minted FOR THIS TARGET, and the
      // file must really be in the bucket.
      if (!isValidSignaturePhotoPath(p) || !p.startsWith(`${targetId}/`)) {
        return NextResponse.json({ error: 'That photo wasn’t uploaded for this signature. Please upload it again.' }, { status: 400 })
      }
      const [folder, file] = p.split('/')
      const { data: found } = await supabaseService.storage.from(SIGNATURE_PHOTO_BUCKET).list(folder, { search: file, limit: 1 })
      if (!found?.some((o: { name: string }) => o.name === file)) {
        return NextResponse.json({ error: 'The photo didn’t finish uploading. Please try again.' }, { status: 400 })
      }
      patch.signature_photo_path = p
    }
  }
  if (typeof body.signature_linkedin_url === 'string') {
    const v = body.signature_linkedin_url.trim()
    if (!v) patch.signature_linkedin_url = null
    else {
      const url = safeHttpUrl(v)
      if (!url) return NextResponse.json({ error: 'LinkedIn must be a web address, like https://www.linkedin.com/in/yourname' }, { status: 400 })
      patch.signature_linkedin_url = url
    }
  }
  if (Object.keys(patch).length === 1) return NextResponse.json({ error: 'Nothing to save' }, { status: 400 })

  const { error } = await supabaseService.from('hub_users').update(patch).eq('id', targetId)
  if (error) {
    console.error('[/api/signature PATCH]', error.message)
    if (/signature_linkedin_url/.test(error.message) && /does not exist|schema cache/i.test(error.message)) {
      return NextResponse.json({ error: 'Your own LinkedIn isn’t switched on yet — migrations/signature_linkedin.sql has not been run.' }, { status: 503 })
    }
    if (/signature_(title|photo_path)/.test(error.message) && /does not exist/i.test(error.message)) {
      return NextResponse.json({ error: 'Email signature storage is not enabled yet — migrations/email_signatures.sql has not been run.' }, { status: 503 })
    }
    return NextResponse.json({ error: 'Couldn’t save the signature.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, targetId })
}
