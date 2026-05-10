'use client'
import dynamic from 'next/dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const App = dynamic(() => import('./BeeHub.js'), { ssr: false }) as any

export default function BeeHubApp({ initialRoute }: { initialRoute?: string }) {
  return <App initialRoute={initialRoute} />
}
