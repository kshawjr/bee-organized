// lib/crm.ts
//
// Shared mapping + auth helpers for the Partners / Contacts / Companies CRM
// (the "Contacts" tab in BeeHub → PartnersScreen). Used by the API routes AND
// by _hub-page.tsx's server fetch so both produce the EXACT same client shape
// that BeeHub's setPartners/setCompanies snapshots expect.
//
// DB is snake_case; the BeeHub client objects are camelCase with embedded jsonb
// sub-records. Soft-delete is `deleted_at` in the DB but the UI reads
// `isDeleted` (boolean) + `deletedAt`, so we map both directions here.

// last_contacted_at exists since migrations/network_phase1.sql (verified
// applied 2026-07-23) — a timestamptz cache maintained ONLY by
// lib/touchpoints.ts on partner reach_out inserts. Read-only here: it is
// deliberately absent from PARTNER_FIELD_MAP so no PATCH can hand-write it.
//
// Tags (tag merge 2026-10-15, lib/tags.ts): a person's tags are the
// partner_tags links, embedded here as `partner_tags(tag_lookup_id)` and
// mapped to `tagIds`. partners.specialties (retired), partners.tags
// (dead, always empty) and partners.relationship (retired into tags,
// migrations/relationship_to_tags.sql) are no longer selected or written. partner_tags is
// service-role only (RLS, no policies): a read through the USER client
// gets an empty embed, so `tagIds` is only trustworthy on service reads —
// which is every read that feeds the Network screen.
import { formatPhone } from '@/lib/phone'
export const PARTNER_COLS =
  'id, location_id, type, name, title, company, company_id, phone, email, website, ' +
  'stage, tier, how_we_met, met_date, last_contact, is_customer, ' +
  'customer_lead_id, card_image, addresses, notes, next_steps, referrals, ' +
  'activity, last_contacted_at, deleted_at, created_at, updated_at, ' +
  'partner_tags(tag_lookup_id)'

export const COMPANY_COLS =
  'id, location_id, name, industry, phone, email, website, addresses, members, ' +
  'notes, activity, deleted_at, created_at, updated_at'

// ─── Row → client object ────────────────────────────────────────────────────
export function mapPartnerRow(row: any) {
  if (!row) return null
  return {
    id: row.id,
    locationId: row.location_id,
    type: row.type || 'partner',
    name: row.name,
    title: row.title || '',
    company: row.company || '',
    companyId: row.company_id || null,
    phone: row.phone || '',
    email: row.email || '',
    website: row.website || '',
    stage: row.stage || '',
    tier: row.tier ?? null,
    tagIds: (row.partner_tags || []).map((t: any) => t.tag_lookup_id),
    howWeMet: row.how_we_met || '',
    metDate: row.met_date || '',
    lastContact: row.last_contact || '',
    isCustomer: !!row.is_customer,
    customerLeadId: row.customer_lead_id ?? null,
    cardImage: row.card_image || null,
    addresses: row.addresses || [],
    notes: row.notes || [],
    nextSteps: row.next_steps || [],
    referrals: row.referrals || [],
    activity: row.activity || [],
    lastContactedAt: row.last_contacted_at || null,
    isDeleted: !!row.deleted_at,
    deletedAt: row.deleted_at || null,
  }
}

export function mapCompanyRow(row: any) {
  if (!row) return null
  return {
    id: row.id,
    locationId: row.location_id,
    name: row.name,
    industry: row.industry || '',
    phone: row.phone || '',
    email: row.email || '',
    website: row.website || '',
    addresses: row.addresses || [],
    members: row.members || [],
    notes: row.notes || [],
    activity: row.activity || [],
    isDeleted: !!row.deleted_at,
    deletedAt: row.deleted_at || null,
  }
}

// ─── Client patch → DB row ──────────────────────────────────────────────────
// Only maps keys that are present on the incoming patch (so PATCH can be
// partial). location_id / id are handled by the route, not here.
const PARTNER_FIELD_MAP: Record<string, string> = {
  type: 'type',
  name: 'name',
  title: 'title',
  company: 'company',
  companyId: 'company_id',
  phone: 'phone',
  email: 'email',
  website: 'website',
  stage: 'stage',
  tier: 'tier',
  howWeMet: 'how_we_met',
  metDate: 'met_date',
  lastContact: 'last_contact',
  isCustomer: 'is_customer',
  customerLeadId: 'customer_lead_id',
  cardImage: 'card_image',
  addresses: 'addresses',
  notes: 'notes',
  nextSteps: 'next_steps',
  referrals: 'referrals',
  activity: 'activity',
}

const COMPANY_FIELD_MAP: Record<string, string> = {
  name: 'name',
  industry: 'industry',
  phone: 'phone',
  email: 'email',
  website: 'website',
  addresses: 'addresses',
  members: 'members',
  notes: 'notes',
  activity: 'activity',
}

function mapPatch(patch: Record<string, any>, fieldMap: Record<string, string>) {
  const row: Record<string, any> = {}
  for (const [clientKey, dbKey] of Object.entries(fieldMap)) {
    if (clientKey in patch) row[dbKey] = patch[clientKey]
  }
  // Universal phone shape (lib/phone.ts). formatPhone never reduces a field
  // holding a second number or words, so a COMPANY (no timeline to keep a
  // note on) saves such a field whole. The partners routes override this
  // with phoneForWrite + a timeline note, the same as a lead.
  if ('phone' in row) row.phone = formatPhone(row.phone)
  return row
}

export function partnerPatchToRow(patch: Record<string, any>) {
  return mapPatch(patch || {}, PARTNER_FIELD_MAP)
}

export function companyPatchToRow(patch: Record<string, any>) {
  return mapPatch(patch || {}, COMPANY_FIELD_MAP)
}

// ─── Auth helpers (mirror /api/seats) ───────────────────────────────────────
export type Caller = { userId: string; role: string; locationId: string | null }

export async function loadCaller(supabase: any): Promise<Caller | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()

  if (!hubUser) return null
  return {
    userId: user.id,
    role: hubUser.role as string,
    locationId: (hubUser.location_id as string | null) ?? null,
  }
}

export function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
}

// Read access: elevated OR same location.
export function canReadLocation(caller: Caller, targetLocationId: string) {
  return isElevated(caller.role) || caller.locationId === targetLocationId
}

// Write access: elevated OR the location's owner/manager. lite_user is
// read-only everywhere else, so it must not be able to create/edit/delete CRM
// data here. (Previously this allowed any hub_user at the location, which
// leaked write access to lite_user — see audit finding at d414443.)
// Manager is a paid operational role and CAN edit CRM data (companies/partners)
// for its own location — see migrations/manager_role.sql.
export function canWriteLocation(caller: Caller, targetLocationId: string) {
  return (
    isElevated(caller.role) ||
    (caller.locationId === targetLocationId &&
      (caller.role === 'owner' || caller.role === 'manager'))
  )
}

// ─── State-only merge for confirmed partner rows ────────────────────────────
// Backs the onPartnerCreated seam: a partner/contact created OUTSIDE
// PartnersContext (the beta ReferrerPicker's inline create — §8.5 forbids it
// calling addPartner) hands its CONFIRMED row up, and BeeHub merges it into
// the same partners state PartnersScreen reads. Dedup by id (a row created
// through addPartner is already present); prepend to match addPartner's
// ordering. Pure — no fetch, the caller already persisted.
export function mergePartnerRow(prev: any[], row: any): any[] {
  if (!row?.id) return prev
  return prev.some((p) => p?.id === row.id) ? prev : [row, ...prev]
}
