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
  currentSubscription?: {
    subscription_status?: string
    subscription_plan?: string | null
    payment_source?: string
    paid_through_date?: string | null
    deferred_until?: string | null
    billing_notes?: string | null
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
