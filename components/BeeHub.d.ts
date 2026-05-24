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
  }
  initialLookups?: LookupsByCategory
  initialPeople?: any[]
  initialBinPeople?: any[]
  // URL routing: server-passed route slug ('clients' / 'reports' / etc.)
  // and optional deep-linked lead id from /clients/[id]; notFoundToast
  // fires the "Lead not found" toast after /clients/[bad-id] redirect.
  initialRoute?: string
  initialSelectedLeadId?: string
  notFoundToast?: boolean
}

declare const BeeHub: React.FC<BeeHubProps>
export default BeeHub
