// lib/email-signature-edit.ts
//
// WHOSE signature the Settings card shows and edits (Kevin, 2026-09-27,
// option 1). PURE.
//
// THE BUG THIS CLOSES. The card used to edit the SIGNED-IN person's own row
// while its preview showed whoever would actually sign at the viewed
// location. Kevin, signed in as himself and viewing Southwest Austin, uploaded
// a headshot and typed "Owner": both landed on Kevin's own account (a super
// admin with no location, who never signs a client email), while the preview
// correctly kept showing Raluca Sharma with an empty title and no photo.
//
// THE RULE. The card edits exactly the person the preview shows — the signer
// resolveEmailSigner picks for this location when the caller stands in as the
// "assignee" (lib/email-signature-resolve.ts):
//
//   caller active at the location  → the caller          (an owner/manager
//                                                         at their own
//                                                         location: their own)
//   otherwise                      → the primary owner   (Kevin viewing
//                                                         Southwest Austin:
//                                                         Raluca)
//   nobody eligible                → nothing to edit; the location signs
//
// Card and preview come from ONE resolver call, so they cannot disagree.
//
// WHO MAY EDIT SOMEONE ELSE'S: super_admin and admin, any location. Everyone
// else (owner, manager, staff, lite_user) may only edit their OWN signature;
// if the signer at the viewed location is someone else, they see it read-only
// with a plain explanation. The server re-derives the target on every write
// and refuses if it is not the one the card showed — the card can never save
// to a person it did not name.

export type SignatureEditTarget = {
  targetId: string | null
  targetName: string | null
  isSelf: boolean
  canEdit: boolean
  reason: 'assignee' | 'primary_owner' | null
}

const ELEVATED = new Set(['super_admin', 'admin'])
export function mayEditOthersSignature(role: string | null | undefined): boolean {
  return ELEVATED.has(String(role ?? ''))
}

export function signatureEditTarget(args: {
  callerId: string
  callerRole: string | null | undefined
  signer: { id: string; full_name: string | null } | null
  reason: 'assignee' | 'primary_owner' | null
}): SignatureEditTarget {
  const { callerId, callerRole, signer, reason } = args
  if (!signer) return { targetId: null, targetName: null, isSelf: false, canEdit: false, reason: null }
  const isSelf = signer.id === callerId
  return {
    targetId: signer.id,
    targetName: signer.full_name?.trim() || null,
    isSelf,
    canEdit: isSelf || mayEditOthersSignature(callerRole),
    reason,
  }
}

// "Your signature" / "Raluca Sharma's signature" — the card's heading. The
// name is never left out when it is someone else's.
export function signatureCardHeading(t: Pick<SignatureEditTarget, 'targetId' | 'targetName' | 'isSelf'>, locationName?: string | null): string {
  if (!t.targetId) return locationName ? `${locationName}’s signature` : 'Signature'
  if (t.isSelf) return 'Your signature'
  const name = t.targetName || 'This person'
  return `${name}${/s$/i.test(name) ? '’' : '’s'} signature`
}

// The one-line explanation under the heading when it is not your own.
export function signatureCardExplainer(t: SignatureEditTarget, locationName: string | null): string | null {
  const loc = locationName || 'this location'
  if (!t.targetId) return `No one at ${loc} can sign emails yet, so they are signed “${/^bee organized/i.test(loc) ? loc : `Bee Organized ${loc}`}”.`
  if (t.isSelf) return null
  const who = t.targetName || 'The primary owner'
  const why = t.reason === 'primary_owner'
    ? `${who} is ${loc}’s primary owner and signs its client emails unless a lead is assigned to someone else.`
    : `${who} signs ${loc}’s client emails.`
  return t.canEdit
    ? `You are editing ${who}’s signature, not your own. ${why}`
    : `${why} Only ${who} or Bee Organized corporate can change it.`
}

// The preview-only note when the location has no website or social links.
// Rendered by the Settings preview — NEVER part of buildSignatureHtml, so it
// can't reach a client email.
export const NO_LINKS_NOTE =
  'No website or social links yet — add them under My Location → Email Signature Links.'

export function locationHasSignatureLinks(links: Record<string, string | null | undefined> | null | undefined): boolean {
  if (!links) return false
  return ['website_url', 'facebook_url', 'instagram_url', 'linkedin_url'].some((k) => !!(links[k] && String(links[k]).trim()))
}

// Title validation, shared by the write route. null = fine.
export const SIGNATURE_TITLE_MAX = 80
export function normalizeSignatureTitle(raw: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const t = raw.replace(/\s+/g, ' ').trim()
  if (t.length > SIGNATURE_TITLE_MAX) return { ok: false, error: `Keep the title under ${SIGNATURE_TITLE_MAX} characters.` }
  return { ok: true, value: t || null }
}
