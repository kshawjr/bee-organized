'use client'
import dynamic from 'next/dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const App = dynamic(() => import('./BeeHub.jsx'), { ssr: false }) as any

type CurrentUser = {
  id: string
  email: string
  name: string
  role: string
  locationId?: string | null
}

type CurrentLocation = {
  id: string
  name: string
  jobber_connected: boolean
  jobber_account_id: string | null
  last_sync_status: string | null
  token_expiry: string | null
}

export default function BeeHubApp({
  initialRoute,
  currentUser,
  currentLocation,
  initialLookups,
}: {
  initialRoute?: string
  currentUser?: CurrentUser
  currentLocation?: CurrentLocation | null
  initialLookups?: Record<string, any[]>
}) {
  return (
    <App
      initialRoute={initialRoute}
      currentUser={currentUser}
      currentLocation={currentLocation}
      initialLookups={initialLookups}
    />
  )
}
