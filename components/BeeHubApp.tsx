'use client'

// This is the bridge between Next.js and the prototype App component.
// BeeHub.jsx is mounted here as a client component.
// As we wire up real data, we'll replace sections of App with
// proper Next.js server components and API calls.

import dynamic from 'next/dynamic'

const App = dynamic(() => import('./BeeHub'), { ssr: false })

export default function BeeHubApp({ initialRoute }: { initialRoute?: string }) {
  return <App initialRoute={initialRoute} />
}
