// lib/email-signature-resolve.ts
//
// WHO signs a client email, and with what — the send-time half of
// {{signature}}. The layout itself is lib/email-signature.ts.
//
// A drip fires days after enrollment on a schedule, so "whoever sent it" has
// no answer. The chain (agreed with Kevin):
//
//   1. the lead's assignee          — if ACTIVE AT THIS LOCATION
//   2. the location's primary owner — if ACTIVE AT THIS LOCATION
//   3. nobody → the location itself: "Bee Organized <Location>"
//
// "Active at this location" = a hub_users row that is not deactivated
// (is_active !== false), not access-removed (disabled_at null), and belongs
// to this location — its hub_users.location_id, or an active seat here. The
// guard exists because leads.assigned_to is an IMPORT STAMP on most leads,
// not an assignment (see the assignment-blanket-stamp memory): one queued
// follow-up is stamped to a super admin, who has no location, and without
// the guard a client would get a corporate signature. Someone who has left
// or moved location falls through the same way.
//
// Whoever signs, the WEBSITE and SOCIAL links are always the LOCATION's —
// Kevin's ruling: location specific, not corporate. A location with none set
// shows none; nothing falls back to beeorganized.com's corporate accounts.
//
// NEVER THROWS, and never blanks the name: the columns this reads arrive with
// migrations/email_signatures.sql, and every read tolerates their absence
// (the booking_link pattern) — pre-migration the signature is name, email and
// mobile only. A signature must never be the reason a drip fails.

import { supabaseService } from './supabase-service'
import { getPrimaryOwnerForLocation } from './owner-resolution'
import { EMPTY_SIGNATURE, type EmailSignature } from './email-signature'

export type SignaturePersonRow = {
  id: string
  full_name: string | null
  email: string | null
  phone: string | null
  is_active: boolean | null
  disabled_at: string | null
  location_id: string | null
  signature_title?: string | null
  signature_photo_path?: string | null
}

export type SignatureCandidate = {
  person: SignaturePersonRow | null
  // Location ids where this person holds an ACTIVE subscription seat.
  seatLocationIds: string[]
}

export type LocationSignatureLinks = {
  website_url: string | null
  facebook_url: string | null
  instagram_url: string | null
  linkedin_url: string | null
}

export const NO_LINKS: LocationSignatureLinks = {
  website_url: null,
  facebook_url: null,
  instagram_url: null,
  linkedin_url: null,
}

// ── PURE: the chain ────────────────────────────────────────────────────────
export function isActiveAtLocation(c: SignatureCandidate | null | undefined, locationId: string): boolean {
  const p = c?.person
  if (!p || !locationId) return false
  if (p.is_active === false) return false
  if (p.disabled_at) return false
  return p.location_id === locationId || c!.seatLocationIds.includes(locationId)
}

export function chooseSignaturePerson(args: {
  locationId: string
  assignee: SignatureCandidate | null
  owner: SignatureCandidate | null
}): SignaturePersonRow | null {
  if (isActiveAtLocation(args.assignee, args.locationId)) return args.assignee!.person
  if (isActiveAtLocation(args.owner, args.locationId)) return args.owner!.person
  return null
}

export function locationDisplayName(locationName: string | null | undefined): string {
  const n = (locationName ?? '').trim()
  if (!n) return 'Bee Organized'
  return /^bee organized\b/i.test(n) ? n : `Bee Organized ${n}`
}

export function assembleSignature(
  person: SignaturePersonRow | null,
  links: LocationSignatureLinks,
  locationName: string | null | undefined,
): EmailSignature {
  const locationLinks = {
    websiteUrl: links.website_url ?? null,
    facebookUrl: links.facebook_url ?? null,
    instagramUrl: links.instagram_url ?? null,
    linkedinUrl: links.linkedin_url ?? null,
  }
  if (!person) {
    return { ...EMPTY_SIGNATURE, name: locationDisplayName(locationName), ...locationLinks }
  }
  return {
    name: person.full_name?.trim() || locationDisplayName(locationName),
    title: person.signature_title ?? null,
    email: person.email ?? null,
    mobile: person.phone ?? null,
    photoPath: person.signature_photo_path ?? null,
    ...locationLinks,
  }
}

// ── IO ────────────────────────────────────────────────────────────────────
async function loadCandidate(userId: string | null | undefined): Promise<SignatureCandidate | null> {
  if (!userId) return null
  try {
    const { data: row } = await supabaseService
      .from('hub_users')
      .select('id, full_name, email, phone, is_active, disabled_at, location_id')
      .eq('id', userId)
      .maybeSingle()
    if (!row) return null
    const { data: seats } = await supabaseService
      .from('subscription_seats')
      .select('location_id')
      .eq('user_id', userId)
      .eq('status', 'active')
    return {
      person: row as SignaturePersonRow,
      seatLocationIds: ((seats as { location_id: string | null }[] | null) ?? [])
        .map((s) => s.location_id)
        .filter((id): id is string => !!id),
    }
  } catch {
    return null
  }
}

// Separate read on purpose: these columns do not exist until
// migrations/email_signatures.sql runs, and naming them in the select above
// would error the whole row away. Absent → nulls → no title, no photo.
async function loadPersonSignatureFields(userId: string): Promise<{ signature_title: string | null; signature_photo_path: string | null }> {
  try {
    const { data, error } = await supabaseService
      .from('hub_users')
      .select('signature_title, signature_photo_path')
      .eq('id', userId)
      .maybeSingle()
    if (error || !data) return { signature_title: null, signature_photo_path: null }
    return {
      signature_title: (data as any).signature_title ?? null,
      signature_photo_path: (data as any).signature_photo_path ?? null,
    }
  } catch {
    return { signature_title: null, signature_photo_path: null }
  }
}

export async function loadLocationSignatureLinks(locationId: string): Promise<LocationSignatureLinks> {
  try {
    const { data, error } = await supabaseService
      .from('locations')
      .select('website_url, facebook_url, instagram_url, linkedin_url')
      .eq('id', locationId)
      .maybeSingle()
    if (error || !data) return NO_LINKS
    return {
      website_url: (data as any).website_url ?? null,
      facebook_url: (data as any).facebook_url ?? null,
      instagram_url: (data as any).instagram_url ?? null,
      linkedin_url: (data as any).linkedin_url ?? null,
    }
  } catch {
    return NO_LINKS
  }
}

// WHO signs, and the signature they sign with — from ONE resolution, so a
// caller that needs both (the Settings card: "Raluca Sharma's signature" +
// its preview) can never show one person and preview another.
//   reason 'assignee'      — the passed assignee, active at this location
//   reason 'primary_owner' — getPrimaryOwnerForLocation, active here
//   reason null            — nobody; the location signs ("Bee Organized X")
export type EmailSigner = {
  signer: SignaturePersonRow | null
  reason: 'assignee' | 'primary_owner' | null
  signature: EmailSignature
}

export async function resolveEmailSigner(args: {
  locationId: string
  locationName: string | null | undefined
  assigneeUserId: string | null | undefined
}): Promise<EmailSigner> {
  const { locationId, locationName, assigneeUserId } = args
  try {
    const assignee = await loadCandidate(assigneeUserId)
    let person: SignaturePersonRow | null = null
    let reason: EmailSigner['reason'] = null
    if (isActiveAtLocation(assignee, locationId)) {
      person = assignee!.person
      reason = 'assignee'
    } else {
      const owner = await getPrimaryOwnerForLocation(locationId).catch(() => null)
      const ownerCandidate = owner && owner.id !== assigneeUserId ? await loadCandidate(owner.id) : null
      person = chooseSignaturePerson({ locationId, assignee, owner: ownerCandidate })
      reason = person ? 'primary_owner' : null
    }
    const personWithFields = person ? { ...person, ...(await loadPersonSignatureFields(person.id)) } : null
    const links = await loadLocationSignatureLinks(locationId)
    return { signer: personWithFields, reason, signature: assembleSignature(personWithFields, links, locationName) }
  } catch {
    return { signer: null, reason: null, signature: assembleSignature(null, NO_LINKS, locationName) }
  }
}

export async function resolveEmailSignature(args: {
  locationId: string
  locationName: string | null | undefined
  assigneeUserId: string | null | undefined
}): Promise<EmailSignature> {
  return (await resolveEmailSigner(args)).signature
}
