// types/index.ts
// ─────────────────────────────────────────────────────────────
// All shared TypeScript types for Bee Hub.
// ─────────────────────────────────────────────────────────────

// ── Roles ─────────────────────────────────────────────────────
export type UserRole = 'super_admin' | 'admin' | 'owner' | 'lite_user'

export type LocationStatus = 'active' | 'onboarding' | 'inactive'

export type SyncStatus = 'success' | 'error' | 'warning' | 'pending'

// ── Hub Users ─────────────────────────────────────────────────
export interface HubUser {
  id: string
  email: string
  role: UserRole
  location_id?: string
  full_name?: string
  is_active: boolean
  created_at: string
  last_sign_in?: string
}

// ── Locations ─────────────────────────────────────────────────
export interface Location {
  id: string
  name: string
  location_id: string           // Zoho Location_ID — unique key, used everywhere
  status: LocationStatus
  timezone: string
  // Jobber connection
  jobber_account_id?: string
  jobber_connected: boolean
  // Tokens stored in Zoho (not here — use getZohoLocation() to read them)
  token_expiry?: string
  token_expiry_display?: string
  last_sync_status?: string
  created_at: string
  updated_at: string
  // Address
  street?: string
  city?: string
  state?: string
  zip?: string
  // Contact
  phone?: string
  email?: string
  owner_name?: string
}

// ── Jobber OAuth ──────────────────────────────────────────────
export interface JobberConnection {
  location_id: string
  connected: boolean
  account_id?: string
  account_name?: string
  connected_at?: string
  token_expiry_display?: string
  last_sync_status?: string
}

// ── Leads (one per Jobber client / account profile) ───────────
// This is the anchor record. One lead = one person.
// Never create two leads for the same Jobber client.
export interface Lead {
  id: string
  location_id: string

  // Jobber anchor — dedup key
  jobber_client_id?: string | null

  // Profile
  name: string
  first_name?: string | null
  last_name?: string | null
  company?: string | null
  email?: string | null
  phone?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null

  // Hive fields
  stage?: string
  source?: string
  project_type?: string
  assigned_to?: string | null
  path?: string | null
  tags?: string[]

  // Sync
  jobber_synced_at?: string | null
  created_at: string
  updated_at: string

  // From leads_with_jobs view (populated on join queries)
  jobs?: Job[]
  job_count?: number
  total_revenue?: number | null
  last_job_date?: string | null
}

// ── Jobs (many per lead) ───────────────────────────────────────
// Always linked to one lead via lead_id.
// Never a standalone record — always belongs to a lead.
export interface Job {
  id: string
  lead_id: string
  location_id: string

  // Jobber reference
  jobber_job_id?: string | null

  // Job details
  title: string
  status: string               // 'In Progress' | 'Completed' | 'Needs Invoice' | etc.
  scheduled_date?: string | null
  completed_date?: string | null
  amount?: number | null
  assigned_team?: string[]
  line_items?: JobLineItem[]

  // Sync
  jobber_synced_at?: string | null
  created_at: string
  updated_at: string
}

export interface JobLineItem {
  name: string
  quantity: number
  unitCost?: { amount: string }
  totalPrice?: { amount: string }
}

// ── Sync Log ──────────────────────────────────────────────────
export interface SyncLogEntry {
  id: string
  location_id: string
  direction: 'outbound' | 'inbound'
  entity_type: 'client' | 'request' | 'quote' | 'job' | 'invoice'
  entity_id?: string
  zoho_record_id?: string
  jobber_record_id?: string
  status: SyncStatus
  message: string
  created_at: string
}

// ── Import ────────────────────────────────────────────────────
export type ImportMode = 'full' | 'dev'

export interface ImportResult {
  success: boolean
  total_clients: number
  mode: ImportMode
  clients_created: number
  clients_updated: number
  jobs_created: number
  jobs_updated: number
  errors: string[]
}

// ── Dashboard Stats ───────────────────────────────────────────
export interface LocationStats {
  location_id: string
  total_clients: number
  active_jobs: number
  pending_quotes: number
  open_invoices: number
  last_sync: string
}

// ── Drip Paths ────────────────────────────────────────────────
export type TouchType = 'email' | 'sms' | 'call_prompt' | 'link' | 'wait'

export interface PathStep {
  id: string
  day: number
  type: TouchType
  label: string
  description?: string
}

export interface DripPath {
  id: string
  name: string
  description: string
  icon: string
  firstTouch: TouchType
  steps: PathStep[]
  isDefault?: boolean
  isCustom?: boolean
}