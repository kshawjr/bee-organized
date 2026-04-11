import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Bee Hub',
  description: 'Franchise Operations Platform',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" data-theme="dark">
      <body>{children}</body>
    </html>
  )
}