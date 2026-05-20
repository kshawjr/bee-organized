// lib/people-mapper.ts
//
// Maps Supabase rows (leads + joined tables) into the Person shape that
// components/BeeHub.jsx consumes. Centralized here so both initial-hydration
// (in app/page.tsx) and any future refetch path can use the same logic.
//
// The Person shape has many fields with no DB-column source today:
//   path, assessment, assessmentType, jobs, invoices, outreachTimeline,
//   activity, jobberRef, jobberClient, jobberSearchStatus, reachOutMethod,
//   estimateSent, estimateApproved, finalProcessed
//
// Those default to safe empty values. As the corresponding tables come
// online (assessments, jobs, invoices already exist — wiring later;
// touchpoints and lead_notes are written by APIs, read here once we add
// the joined queries in Phase 3B).

type LeadRow = {
  id: string
  location_uuid: string | null
  location_id: string // legacy slug, still populated by Jobber import
  assigned_to: string | null
  name: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  stage: string | null
  source: string | null
  project_type: string | null
  is_junk: boolean | null
  drip_path: string | null
  move_drip_path: string | null
  final_processed: boolean | null
  final_processed_at: string | null
  closed_lost_reason: string | null
  closed_lost_note: string | null
  referred_by_kind: string | null
  referred_by_id: string | null
  addresses: any
  jobber_client_id: string | null
  jobber_synced_at: string | null
  created_at: string | null
  updated_at: string | null
}

function fmtCreatedShort(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${months[d.getMonth()]} ${d.getDate()}`
  } catch {
    return ''
  }
}

export function mapLeadToPerson(row: LeadRow) {
  // Addresses jsonb is already the right shape ({type, value, street, city, state, zip}).
  // Empty array if no addresses set. Legacy single-field address from the
  // `leads.address` column gets shimmed when addresses is empty so the UI
  // can show *something* for leads that came in pre-migration.
  const addresses = Array.isArray(row.addresses) ? row.addresses : []
  const legacyAddr = addresses.length === 0 && row.address
    ? [{ type: 'Service', value: row.address, street: row.address, city: row.city || '', state: row.state || '', zip: row.zip || '' }]
    : []
  const finalAddresses = addresses.length > 0 ? addresses : legacyAddr

  return {
    id: row.id,
    assignedTo: row.assigned_to,
    locationId: row.location_id, // slug — keeps existing BeeHub filtering working

    // Identity
    name: row.name || [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || '(unnamed)',
    phone: row.phone || '',
    email: row.email || '',

    // Address (legacy + new jsonb)
    address: finalAddresses[0]?.value || row.address || '',
    addresses: finalAddresses,

    // Pipeline
    stage: row.stage || 'New',
    source: row.source || '',
    project: row.project_type || '',
    created: fmtCreatedShort(row.created_at),

    // Tags — empty for now, populated by Phase 3B's joined query
    tags: [],

    // Junk / final processed
    isJunk: row.is_junk || false,
    finalProcessed: row.final_processed || false,

    // Referral
    referredBy: row.referred_by_id || null,
    referredByKind: row.referred_by_kind || null,

    // Drip path
    path: row.drip_path || null,
    moveDripPath: row.move_drip_path || null,

    // Close-out
    closedLostReason: row.closed_lost_reason || null,
    closedLostNote: row.closed_lost_note || null,

    // Jobber state — derived from current columns
    jobberRef: row.jobber_client_id || null,
    jobberClient: null, // joined query in Phase 3B
    jobberSearchStatus: row.jobber_client_id ? 'found' : 'not_found',

    // Notes — empty for now, joined query in Phase 3B
    buzzNotes: [],
    jobNotes: [],

    // Job contacts — empty for now, joined query in Phase 3B
    jobContacts: [],

    // Activity / timeline — empty for now, joined query in Phase 3B
    outreachTimeline: [],
    activity: [],

    // Jobs / invoices — empty for now, joined query in Phase 3B
    jobs: [],
    invoices: [],

    // Assessment — empty for now, joined query in Phase 3B
    assessment: null,
    assessmentType: null,

    // Reach-out — derived in Phase 3B from latest touchpoint
    reachOutMethod: null,

    // Other Person fields the UI may reference — safe defaults
    jobDetail: '',
    paused: false,
    estimateSent: false,
    estimateApproved: false,
  }
}