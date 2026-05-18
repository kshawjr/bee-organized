import * as React from 'react'

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
  } | null
  currentUser?: {
    id: string
    email: string
    name: string
    role: string
    locationId?: string | null
  }
}

declare const BeeHub: React.FC<BeeHubProps>
export default BeeHub
