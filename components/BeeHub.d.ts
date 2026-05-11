import { ComponentType } from 'react'

export interface BeeHubProps {
  initialRole?: string
  initialFranchiseRole?: string
  initialLocFilter?: string
  initialGuideSlides?: Array<{
    icon?: string | null
    chapter?: string | null
    color?: string | null
    title: string
    body?: string | null
    bullets?: string[]
    screenshot?: string | null
  }>
  currentUser?: {
    id: string
    email: string
    name: string
    role: string
    locationId: string | null
  }
}

declare const BeeHub: ComponentType<BeeHubProps>
export default BeeHub
