import { requireAuth } from '@/lib/auth'
import Link from 'next/link'
import ThemeToggle from '@/components/ThemeToggle'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const user = await requireAuth()

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside style={{
        width: '220px',
        background: 'var(--bg-card)',
        borderRight: '1px solid var(--border)',
        padding: '1.5rem 1rem',
        position: 'fixed',
        top: 0,
        left: 0,
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{ marginBottom: '2rem' }}>
          <div style={{ fontSize: '24px', marginBottom: '4px' }}>🐝</div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>Bee Hub</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{user.email}</div>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <Link href="/dashboard" style={{ color: 'var(--text-secondary)', textDecoration: 'none', padding: '8px 10px', borderRadius: '6px', fontSize: '14px' }}>
            Overview
          </Link>
          <Link href="/dashboard/locations" style={{ color: 'var(--text-secondary)', textDecoration: 'none', padding: '8px 10px', borderRadius: '6px', fontSize: '14px' }}>
            Locations
          </Link>
          <Link href="/dashboard/sync" style={{ color: 'var(--text-secondary)', textDecoration: 'none', padding: '8px 10px', borderRadius: '6px', fontSize: '14px' }}>
            Sync Log
          </Link>
        </nav>

        <div style={{ marginTop: 'auto' }}>
          <ThemeToggle />
        </div>
      </aside>

      <main style={{ flex: 1, marginLeft: '220px', padding: '2rem', background: 'var(--bg)', minHeight: '100vh', color: 'var(--text-primary)' }}>
        {children}
      </main>
    </div>
  )
}