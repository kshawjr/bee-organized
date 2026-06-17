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

export const PARTNER_COLS =
  'id, location_id, type, name, title, company, company_id, phone, email, website, ' +
  'stage, specialties, tier, tags, how_we_met, met_date, last_contact, is_customer, ' +
  'customer_lead_id, relationship, card_image, addresses, notes, next_steps, referrals, ' +
  'activity, deleted_at, created_at, updated_at'

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
    specialties: row.specialties || [],
    tier: row.tier ?? null,
    tags: row.tags || [],
    howWeMet: row.how_we_met || '',
    metDate: row.met_date || '',
    lastContact: row.last_contact || '',
    isCustomer: !!row.is_customer,
    customerLeadId: row.customer_lead_id ?? null,
    relationship: row.relationship || '',
    cardImage: row.card_image || null,
    addresses: row.addresses || [],
    notes: row.notes || [],
    nextSteps: row.next_steps || [],
    referrals: row.referrals || [],
    activity: row.activity || [],
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
  specialties: 'specialties',
  tier: 'tier',
  tags: 'tags',
  howWeMet: 'how_we_met',
  metDate: 'met_date',
  lastContact: 'last_contact',
  isCustomer: 'is_customer',
  customerLeadId: 'customer_lead_id',
  relationship: 'relationship',
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
