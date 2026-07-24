// lib/lead-to-network.ts
// ─────────────────────────────────────────────────────────────
// The lead → Network conversion's pure/server half: the DEDUP GATE and the
// FIELD MAPPING. Both live here so the route stays auth + orchestration and
// the two decisions that actually matter are unit-testable without a request.
//
// WHY THE MATCH IS SERVER-SIDE (and not the clientMatch pool gate the other
// doors use): the Inbox is usable on 'All Locations', where NetworkScreen's
// locationRequired means ZERO partner rows are loaded client-side. A pool
// match there would find nothing and blind-create a duplicate on every press
// — the one scope where the door is most likely to be used on an old record.
// So the gate is a real query, always, and the client-side preview is only a
// preview (the route re-runs this before it writes, the same
// queryLeadMatches discipline the intake door uses).
//
// WHY NOT queryLeadMatches ITSELF: it queries `leads` and matches phone
// against phone_normalized — a GENERATED digits-only column that exists on
// leads and NOT on partners (migrations/partners.sql has plain `phone text`;
// network_phase1.sql adds only last_contacted_at). There is no indexed
// digits key on the partner side, so the phone half is a scan + a JS
// comparison. Bounded and paged like /api/partners GET, and honest about it:
// past the ceiling we log rather than silently under-matching.
//
// MATCH SEMANTICS: exact on both keys — email (lowercased) and phone
// (digits). Deliberately NOT matchPeople's as-you-type `includes` for phone:
// this is the authoritative pre-write gate, and classifyLeadMatches
// (the other authoritative gate) is exact for the same reason. A substring
// phone hit would link two different people who share a 7-digit run.
// NAME IS NEVER A MATCH KEY HERE — two Karen Martinezes are two people, and
// a wrong link is worse than a duplicate (it welds a stranger's referral
// history onto a client record).
// ─────────────────────────────────────────────────────────────

import { normalizeEmail, normalizePhone } from '@/components/hive/shared/clientMatch'

// Mirrors /api/partners GET — PostgREST's invisible 1,000-row default is not
// "unlimited", so we page explicitly and say so when we hit the ceiling.
const PAGE = 1000
const MAX_ROWS = 5000

// The seed every create door uses. A NULL stage matches no PARTNER_STAGE_KEYS
// filter, so a stage-less partner hides from every stage-filtered and saved
// Network view until someone hand-edits it. This is door #4 — same seed as
// NetworkAddSheet, AddPartnerModal and ReferrerPicker.
export const NEW_PARTNER_STAGE = 'New Contact'

export type PartnerMatch = {
  partner: any
  matchedOn: 'email' | 'phone'
}

// Authoritative dedup gate. Returns the first live partner in this location
// whose email or phone is the same person, or null. Email outranks phone
// (same order matchPeople uses), so a row matching both reports 'email'.
export async function findPartnerForLead(
  supabaseService: any,
  { locationId, email, phone }: { locationId: string; email?: string | null; phone?: string | null }
): Promise<PartnerMatch | null> {
  const e = normalizeEmail(email)
  const d = normalizePhone(phone)
  // No usable key → no match. Never fall through to a name comparison.
  if (!e && !d) return null

  const rows: any[] = []
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabaseService
      .from('partners')
      .select('id, name, email, phone, stage, specialties, is_customer, customer_lead_id, location_id')
      .eq('location_id', locationId)
      .is('deleted_at', null)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message || 'partner match query failed')
    rows.push(...(data || []))
    if ((data || []).length < PAGE) break
  }
  if (rows.length >= MAX_ROWS) {
    console.warn(
      `[lead-to-network] partner match scanned the ${MAX_ROWS}-row ceiling for ${locationId} — a match beyond it would be missed`
    )
  }

  let phoneHit: any = null
  for (const r of rows) {
    if (e && normalizeEmail(r.email) === e) return { partner: r, matchedOn: 'email' }
    if (d && !phoneHit && normalizePhone(r.phone) === d) phoneHit = r
  }
  return phoneHit ? { partner: phoneHit, matchedOn: 'phone' } : null
}

// ── lead row → partner insert row ───────────────────────────────────────────
// Snake_case DB row (not the camelCase client shape) — the route inserts it
// directly, the same way POST /api/partners inserts partnerPatchToRow output.
//
// What carries, what does not, and why, is the whole point of this function:
//
//   name/email/phone   → 1:1
//   location_uuid      → location_id (both uuid; the touchpoints route scopes
//                        partners on exactly this equivalence)
//   addresses          → [{type:'Business', value, street, city, state, zip}]
//                        composed the same way NetworkAddSheet composes its
//                        single address, so the two doors produce one shape
//   source             → how_we_met (the only honest provenance mapping)
//   request_details    → a first note (what they originally asked for is
//                        context on the relationship, not a partner field)
//   created_at         → met_date, FORMATTED — met_date is free text in the
//                        UI ('Nov 2024', 'Just now'), never a date column
//
// DROPPED, deliberately: stage (lead pipeline vocabulary is disjoint from the
// partner one — never crossed), project_type, drip_path/move_drip_path,
// is_junk, snoozed_*, marketing_opt_out, paused, jobber_client_id and every
// Jobber child (quotes/jobs/invoices/assessments/service_requests),
// engagements, paid_amount, closed_lost_*, assigned_to, inbox_dismissed_at,
// and lead tags (a lead_tags junction against a tag_lookups vocabulary; the
// partner `tags` text[] is a different vocabulary — mapping them would invent
// meaning). referred_by_kind/referred_by_id is NOT the link: it records who
// referred THIS LEAD, a different fact entirely.
export function leadToPartnerRow(
  lead: any,
  { specialties = [], stage = NEW_PARTNER_STAGE }: { specialties?: string[]; stage?: string } = {}
) {
  const name =
    (lead?.name || '').trim() ||
    [lead?.first_name, lead?.last_name].filter(Boolean).join(' ').trim()

  return {
    type: 'partner',
    name,
    email: lead?.email || null,
    phone: lead?.phone || null,
    location_id: lead?.location_uuid,
    stage,
    specialties,
    addresses: leadAddresses(lead),
    how_we_met: lead?.source || '',
    met_date: fmtMetDate(lead?.created_at),
    notes: lead?.request_details
      ? [
          {
            id: `n${Date.parse(lead.created_at || '') || 0}`,
            text: String(lead.request_details).trim(),
            ts: lead.created_at || null,
            user: 'Imported from client record',
          },
        ]
      : [],
    activity: [{ type: 'event', label: 'Added to Network from a client record', ts: 'Just now' }],
    tags: [],
    referrals: [],
    next_steps: [],
  }
}

// leads carry BOTH an addresses jsonb and the legacy flat columns. Prefer the
// jsonb's first entry (what the record actually shows), fall back to composing
// the flat ones, and emit nothing rather than a row of empty strings.
function leadAddresses(lead: any) {
  const first = Array.isArray(lead?.addresses) ? lead.addresses[0] : null
  const value =
    (first?.value || '').trim() ||
    [lead?.address, lead?.city, lead?.state, lead?.zip].filter(Boolean).join(', ')
  if (!value) return []
  return [
    {
      type: 'Business',
      value,
      street: first?.street || lead?.address || '',
      apt: first?.apt || '',
      city: first?.city || lead?.city || '',
      state: first?.state || lead?.state || '',
      zip: first?.zip || lead?.zip || '',
    },
  ]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// met_date is a free-text display field. '' beats a bogus date string.
function fmtMetDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const t = d.getTime()
  if (!Number.isFinite(t)) return ''
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

// ── fields worth back-filling onto a MATCHED partner ─────────────────────────
// Match-then-link must not overwrite what the Network already knows: the
// partner row is hand-curated, the lead row is whatever a webform captured.
// So this is FILL-EMPTY ONLY, the same rule the intake merge uses — plus the
// stage rescue, because a pre-existing stage-less partner (created before the
// three doors were fixed) is invisible to every stage filter and this is a
// free chance to put it back in the pipeline.
export function fillEmptyPartnerPatch(partner: any, lead: any, specialties: string[] = []) {
  const patch: Record<string, any> = {}
  if (!partner?.email && lead?.email) patch.email = lead.email
  if (!partner?.phone && lead?.phone) patch.phone = lead.phone
  if (!partner?.stage) patch.stage = NEW_PARTNER_STAGE
  if (!(partner?.specialties || []).length && specialties.length) patch.specialties = specialties
  return patch
}
