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

export default function BeeHubApp({
  initialRoute,
  currentUser,
}: {
  initialRoute?: string
  currentUser?: CurrentUser
}) {
  return <App initialRoute={initialRoute} currentUser={currentUser} />
}
