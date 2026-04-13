import { requireAuth, getHubUser, isSuperAdmin, isAdmin } from '@/lib/auth'
import { getZohoLocations } from '@/lib/zoho'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import Link from 'next/link'

export default async function DashboardPage() {
  const user = await requireAuth()
  const hubUser = await getHubUser()
  const supabaseDebug = await createServerSupabaseClient()
const { data: debugUser } = await supabaseDebug.from('hub_users').select('*').eq('email', 'kevin@bmave.com').single()
console.log('Debug direct query:', debugUser)
  
  

  console.log('Auth user:', user?.email)
  console.log('Hub user:', hubUser)

  if (!hubUser) {
    redirect('/login')
  }

  const role = hubUser.role
  const locations = await getZohoLocations()

  const visibleLocations = isAdmin(role)
    ? locations
    : locations.filter((l: any) => l.Location_ID === hubUser.location_id)

  const supabase = await createServerSupabaseClient()
  const { data: recentLogs } = await supabase
    .from('sync_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5)

  const total = visibleLocations.length
  const active = visibleLocations.filter((l: any) => l.CRM_Status === 'Active').length
  const pending = visibleLocations.filter((l: any) => l.CRM_Status === 'Pending').length
  const connected = visibleLocations.filter((l: any) => l.Jobber_Account_ID).length
  const notConnected = active - connected

  const cardStyle = {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    padding: '1.25rem',
  }

  const statCard = (label: string, value: number | string, color?: string, sub?: string) => (
    <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column' as const, gap: '0.25rem' }}>
      <p style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: '0.5px', fontWeight: 500 }}>{label}</p>
      <p style={{ fontSize: '2rem', fontWeight: 700, color: color || 'var(--text-primary)', lineHeight: 1 }}>{value}</p>
      {sub && <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{sub}</p>}
    </div>
  )

  return (
    <div>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '4px' }}>
          {isSuperAdmin(role) ? 'Overview' : `${visibleLocations[0]?.Name || 'Dashboard'}`}
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--text-muted)' }}>
          {isSuperAdmin(role) ? 'All franchise locations' : `${role.replace('_', ' ')} · ${hubUser.location_id || ''}`}
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', marginBottom: '2rem' }}>
        {isAdmin(role) && (
          <>
            {statCard('Total Locations', total)}
            {statCard('Active', active, '#22c55e')}
            {statCard('Jobber Connected', connected, '#3b82f6', `${notConnected} need setup`)}
            {statCard('Pending', pending, '#f59e0b')}
          </>
        )}
        {!isAdmin(role) && visibleLocations[0] && (
          <>
            {statCard('Location', visibleLocations[0].Name)}
            {statCard('Status', visibleLocations[0].CRM_Status, visibleLocations[0].CRM_Status === 'Active' ? '#22c55e' : '#f59e0b')}
            {statCard('Jobber', visibleLocations[0].Jobber_Account_ID ? 'Connected' : 'Not Connected', visibleLocations[0].Jobber_Account_ID ? '#22c55e' : '#ef4444')}
            {statCard('Timezone', visibleLocations[0].Time_Zone || '—')}
          </>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>

        {isAdmin(role) && notConnected > 0 && (
          <div style={cardStyle}>
            <h2 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '1rem' }}>
              Needs Setup
            </h2>
            <div style={{ display: 'grid', gap: '6px' }}>
              {visibleLocations
                .filter((l: any) => l.CRM_Status === 'Active' && !l.Jobber_Account_ID)
                .slice(0, 5)
                .map((l: any) => (
                  <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: 'var(--bg-elevated)', borderRadius: '6px' }}>
                    <span style={{ fontSize: '13px' }}>{l.Name}</span>
                    <Link href={`/dashboard/locations/${l.Location_ID}`} style={{ fontSize: '12px', color: 'var(--brand)', textDecoration: 'none' }}>
                      Setup →
                    </Link>
                  </div>
                ))}
              {notConnected > 5 && (
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', paddingTop: '4px' }}>
                  +{notConnected - 5} more
                </p>
              )}
            </div>
          </div>
        )}

        <div style={{ ...cardStyle, gridColumn: isAdmin(role) && notConnected > 0 ? 'auto' : '1 / -1' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Recent Activity
            </h2>
            <Link href="/dashboard/sync" style={{ fontSize: '12px', color: 'var(--brand)', textDecoration: 'none' }}>
              View all →
            </Link>
          </div>
          {recentLogs && recentLogs.length > 0 ? (
            <div style={{ display: 'grid', gap: '6px' }}>
              {recentLogs.map((log: any) => (
                <div key={log.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: 'var(--bg-elevated)', borderRadius: '6px' }}>
                  <div>
                    <p style={{ fontSize: '13px', fontWeight: 500 }}>{log.entity_id}</p>
                    <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{log.location_id} · {new Date(log.created_at).toLocaleString()}</p>
                  </div>
                  <span style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: '20px',
                    background: log.status === 'success' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                    color: log.status === 'success' ? '#22c55e' : '#ef4444',
                  }}>
                    {log.message?.split(' — ')[0] || log.status}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: '14px', color: 'var(--text-muted)' }}>No sync activity yet. Run an import to see activity here.</p>
          )}
        </div>

        <div style={{ ...cardStyle, gridColumn: '1 / -1' }}>
          <h2 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '1rem' }}>
            Quick Links
          </h2>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' as const }}>
            <Link href="/dashboard/locations" style={{ padding: '8px 16px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '13px', textDecoration: 'none', color: 'var(--text-primary)' }}>
              📍 Locations
            </Link>
            <Link href="/dashboard/sync" style={{ padding: '8px 16px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '13px', textDecoration: 'none', color: 'var(--text-primary)' }}>
              🔄 Sync Log
            </Link>
            {isAdmin(role) && (
              <Link href="/dashboard/locations/loc_test" style={{ padding: '8px 16px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '13px', textDecoration: 'none', color: 'var(--text-primary)' }}>
                🧪 Test Location
              </Link>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}