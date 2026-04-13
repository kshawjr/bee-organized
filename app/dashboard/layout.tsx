import { requireAuth, getHubUser, isSuperAdmin, isAdmin } from '@/lib/auth'
import Link from 'next/link'
import ThemeToggle from '@/components/ThemeToggle'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const user = await requireAuth()
  const hubUser = await getHubUser()
  const role = hubUser?.role || 'lite_user'

  const navLink = {
    color: 'rgba(255,255,255,0.85)',
    textDecoration: 'none',
    padding: '8px 10px',
    borderRadius: '6px',
    fontSize: '14px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  } as React.CSSProperties

  const sectionLabel = {
    fontSize: '10px',
    fontWeight: 600,
    color: 'rgba(168,201,196,0.6)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    padding: '0 10px',
    marginBottom: '4px',
  }

  const divider = {
    height: '1px',
    background: 'rgba(168,201,196,0.12)',
    margin: '10px 0',
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside style={{
        width: '220px',
        background: '#1a2e2b',
        padding: '1.5rem 1rem',
        position: 'fixed',
        top: 0,
        left: 0,
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Brand */}
        <div style={{ marginBottom: '2rem', paddingLeft: '10px' }}>
          <div style={{ fontSize: '24px', marginBottom: '4px' }}>🐝</div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: '#a8c9c4', fontFamily: 'Playfair Display, serif' }}>Bee Hub</div>
          <div style={{ fontSize: '11px', color: 'rgba(168,201,196,0.65)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {user.email}
          </div>
          <div style={{ fontSize: '10px', color: 'rgba(168,201,196,0.4)', marginTop: '2px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {role.replace('_', ' ')}
          </div>
        </div>

        {/* Nav */}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>

          <p style={sectionLabel}>Main</p>

          <Link href="/dashboard" style={navLink}>
            <span>◻</span> Overview
          </Link>
          <Link href="/dashboard/locations" style={navLink}>
            <span>📍</span> Locations
          </Link>
          <Link href="/dashboard/sync" style={navLink}>
            <span>🔄</span> Sync Log
          </Link>

          {/* Admin section */}
          {isAdmin(role) && (
            <>
              <div style={divider} />
              <p style={sectionLabel}>Admin</p>
              <Link href="/dashboard/admin" style={navLink}>
                <span>⚙️</span> Settings
              </Link>
              <Link href="/dashboard/admin/users" style={navLink}>
                <span>👥</span> Users
              </Link>
            </>
          )}

          {/* Super admin only */}
          {isSuperAdmin(role) && (
            <>
              <div style={divider} />
              <p style={sectionLabel}>Dev</p>
              <Link href="/dashboard/locations/loc_test" style={{ ...navLink, color: 'rgba(255,255,255,0.45)', fontSize: '13px' }}>
                <span>🧪</span> Test Location
              </Link>
            </>
          )}
        </nav>

        <div style={{ marginTop: 'auto', paddingLeft: '4px' }}>
          <div style={divider} />
          <ThemeToggle />
        </div>
      </aside>

      <main style={{
        flex: 1,
        marginLeft: '220px',
        padding: '2.5rem 3rem',
        background: 'var(--bg)',
        minHeight: '100vh',
        color: 'var(--text-primary)',
      }}>
        {children}
      </main>
    </div>
  )
}