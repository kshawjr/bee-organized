import * as React from 'react'

export interface Lookup {
  id: string
  category: string
  label: string
  sort_order: number
  color: string | null
  bg_color: string | null
  icon: string | null
  description: string | null
  attrs: Record<string, any>
  is_active: boolean
  created_at?: string
  updated_at?: string
}

export type LookupsByCategory = Record<string, Lookup[]>

interface BeeHubProps {
  initialRole?: string
  initialFranchiseRole?: string
  initialLocFilter?: string
  initialGuideSlides?: Array<{
    icon?: string | null
    chapter?: string | null
    color?: string
    title: string
    body?: string
    bullets?: string[]
    screenshot?: string | null
    screenshots?: string[]
  }>
  initialManualSlides?: Array<{
    icon?: string | null
    chapter?: string | null
    color?: string
    title: string
    body?: string
    bullets?: string[]
    screenshot?: string | null
    screenshots?: string[]
    video_url?: string | null
  }>
  initialTierPrices?: Array<{
    id: string
    display_name: string
    price_annual: number
    description?: string | null
    sort_order: number
    updated_at?: string | null
  }>
  initialLocations?: Array<{
    id: string
    name: string
    state?: string
    owner?: string | null
    crmStatus?: string
    lifecycle_status?: string
    subscription_status?: string
    subscription_plan?: string | null
    payment_source?: string
    paid_through_date?: string | null
    billing_notes?: string | null
    jobberConnected?: boolean
    jobberAccountId?: string | null
    leads?: number
    revenue?: number
    collected?: number
    userCount?: number
    joinedDate?: string
    onboarding_state?: {
      completedSteps?: Record<string, boolean>
      activeStepOpen?: string | null
      lastUpdated?: string
    }
    default_drip_path?: string
    default_move_drip_path?: string
    activated_at?: string | null
    [key: string]: any
  }> | null
  initialUsers?: Array<{
    id: string
    name: string
    initials: string
    email: string
    locationId: string | null
    role: string
    status: string
    joined: string
  }> | null
  initialSeats?: Array<{
    id: string
    location_id: string
    tier: 'owner' | 'manager' | 'light' | 'readonly'
    user_id: string | null
    status: 'active' | 'inactive'
    added_at: string
    removed_at?: string | null
    prorated_cost?: number | null
    added_by?: string | null
    notes?: string | null
  }>
  initialPendingInvites?: Array<{
    id: string
    location_id: string
    email: string
    full_name?: string | null
    role?: string
    tier: 'owner' | 'manager' | 'light' | 'readonly'
    invite_expires_at?: string
    accepted_at?: string | null
    created_at?: string
  }>
  currentSubscription?: {
    subscription_status?: string
    subscription_plan?: string | null
    payment_source?: string
    paid_through_date?: string | null
    deferred_until?: string | null
    billing_notes?: string | null
  } | null
  currentLocation?: {
    id: string
    name: string
    jobber_connected: boolean
    jobber_account_id: string | null
    last_sync_status: string | null
    token_expiry: string | null
    lifecycle_status?: string
    onboarding_state?: {
      completedSteps?: Record<string, boolean>
      activeStepOpen?: string | null
      lastUpdated?: string
    }
    default_drip_path?: string
    default_move_drip_path?: string
    // Pass 2 — location-step + paths-step + launch fields
    address?: string
    city?: string
    state?: string
    zip?: string
    phone?: string
    email?: string
    timezone?: string
    sender_name?: string
    send_from_email?: string
    reply_to_email?: string
    reviews_link?: string
    calendar_link?: string
    activated_at?: string | null
  } | null
  currentUser?: {
    id: string
    email: string
    name: string
    role: string
    locationId?: string | null
    // Pass 2 — profile fields for pre-filling the profile step form
    first_name?: string | null
    last_name?: string | null
    phone?: string | null
    // This user's OWN scheduling link — seeds Settings → Profile → Booking
    // Link and backs {{owner_booking_link}}. null until they set one, or
    // whenever migrations/hub_users_booking_link.sql hasn't been run.
    booking_link?: string | null
    // Phase 2 — is this owner the DESIGNATED primary owner of their location?
    // false routes a co-owner into the slim onboarding flow. Defaults true for
    // non-owners / legacy owners with no seat row.
    isPrimaryOwner?: boolean
  }
  initialLookups?: LookupsByCategory
  initialPeople?: any[]
  initialBinPeople?: any[]
  // loc_other unrouted leads, fetched outside the selected location scope so
  // the routing queue survives a location switch (Fix 2 Phase 2).
  initialTransferPeople?: any[]
  // Server-reduced corporate overview for 'All Locations' (Fix 2 Phase 4).
  // Null on a scoped load, where Home derives from the loaded people graph.
  initialAllOverview?: {
    newUncontacted: { count: number; oldestDays: number }
    estimateFollowUps: { count: number; oldestDays: number }
    upcomingAssessments: Array<{ id: string; scheduled_at: string; client: string }>
    agingInvoices: { count: number; total: number; oldestDays: number }
    openEngagementsCount: number
    activeClientsCount: number
    newThisWeekCount: number
    outstandingTotal: number
    leadCount: number
    truncated: boolean
  } | null
  // True when the leads load hit MAX_LEADS, so the page's counts are short.
  initialLeadsTruncated?: boolean
  // True when the partners/companies load hit MAX_NETWORK_ROWS — the Network
  // screen states the shortfall instead of rendering a quietly short list.
  initialNetworkTruncated?: boolean
  // The location the server actually scoped to (null = all locations). The
  // client reconciles its scope cookie to this after hydration.
  initialScopeLocationId?: string | null
  // HIVE Phase 1 step 4: open engagements for the new EngagementBoard
  // (dual-read; unused by the legacy board). Rows carry client_name,
  // repeat_count, and minimal quotes/jobs/invoices for the stage chips.
  initialEngagements?: any[]
  // Count of terminal engagements (List lens 'Closed · N' chip) — rows
  // page in lazily via GET /api/engagements?closed=1.
  initialEngagementsClosedCount?: number
  // Won share of the closed count (List Won/Lost chips; lost = closed − won)
  initialEngagementsClosedWonCount?: number
  initialPartners?: any[]
  initialCompanies?: any[]
  // URL routing: server-passed route slug ('clients' / 'reports' / etc.)
  // and optional deep-linked lead id from /clients/[id]; notFoundToast
  // fires the "Lead not found" toast after /clients/[bad-id] redirect.
  initialRoute?: string
  initialSelectedLeadId?: string
  // Optional deep-linked engagement id from /clients/[id]?e=<id>; opens the
  // EngagementPanel on mount (server-validated: belongs to the scoped client).
  initialSelectedEngagementId?: string
  notFoundToast?: boolean
}

declare const BeeHub: React.FC<BeeHubProps>
export default BeeHub
