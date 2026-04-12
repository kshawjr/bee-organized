import { requireAuth } from '@/lib/auth'
import { getZohoLocation } from '@/lib/zoho'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import ImportSection from './ImportSection'

interface Props {
  params: { id: string }
}

export default async function LocationDetailPage({ params }: Props) {
  await requireAuth()
  const location = await getZohoLocation(params.id)
  if (!location) notFound()

  const tokenExpiry = location.Token_Expiry ? parseInt(location.Token_Expiry) : 0
  const remaining = tokenExpiry - Date.now()
  const tokenColor = !tokenExpiry ? 'var(--text-muted)' : remaining < 5 * 60 * 1000 ? '#ef4444' : remaining < 15 * 60 * 1000 ? '#f59e0b' : '#22c55e'

  return (
    <div style={{ maxWidth: '860px' }}>
      <Link href="/dashboard/locations" style={{ fontSize: '13px', color: 'var(--text-muted)', textDecoration: 'none', marginBottom: '1.5rem', display: 'block' }}>
        ← Back to locations
      </Link>

      <div style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
          <h1 style={{ fontSize: '24px', fontWeight: 700 }}>{location.Name}</h1>
          <span style={{
            fontSize: '12px',
            padding: '2px 8px',
            borderRadius: '20px',
            background: location.CRM_Status === 'Active' ? 'rgba(34,197,94,0.1)' : location.CRM_Status === 'Pending' ? 'rgba(245,158,11,0.1)' : 'var(--bg-elevated)',
            color: location.CRM_Status === 'Active' ? '#22c55e' : location.CRM_Status === 'Pending' ? '#f59e0b' : 'var(--text-muted)',
          }}>
            {location.CRM_Status}
          </span>
        </div>
        {location.Group_Email && (
          <p style={{ fontSize: '14px', color: 'var(--text-muted)' }}>{location.Group_Email}</p>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>

        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.25rem' }}>
          <h2 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Details</h2>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <div>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>Location ID</p>
              <code style={{ fontSize: '12px', background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: '4px', color: 'var(--text-secondary)' }}>{location.Location_ID}</code>
            </div>
            <div>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>Phone</p>
              <p style={{ fontSize: '13px' }}>{location.Phone_Number || '—'}</p>
            </div>
            <div>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>Timezone</p>
              <p style={{ fontSize: '13px' }}>{location.Time_Zone || '—'}</p>
            </div>
            <div>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>Group Email</p>
              <p style={{ fontSize: '13px' }}>{location.Group_Email || '—'}</p>
            </div>
          </div>
        </div>

        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.25rem' }}>
          <h2 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Jobber</h2>
          {location.Jobber_Account_ID ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e', display: 'inline-block' }}></span>
                <span style={{ fontSize: '14px', color: '#22c55e', fontWeight: 500 }}>Connected</span>
              </div>
              <div style={{ display: 'grid', gap: '0.75rem' }}>
                <div>
                  <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>Last Sync</p>
                  <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{location.Last_Sync_Status || '—'}</p>
                </div>
                <div>
                  <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>Token Expiry</p>
                  <p style={{ fontSize: '12px', color: tokenColor, fontWeight: 500 }}>
                    {tokenExpiry ? new Date(tokenExpiry).toLocaleString() : '—'}
                  </p>
                </div>
                <div>
                  <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>Account ID</p>
                  <code style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{location.Jobber_Account_ID.slice(0, 30)}...</code>
                </div>
                <div>
                  <a href={`/api/jobber/connect?location_id=${location.Location_ID}`} style={{ fontSize: '12px', color: 'var(--text-muted)', textDecoration: 'none', borderBottom: '1px solid var(--border)' }}>
                    Reconnect
                  </a>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                This location is not connected to Jobber.
              </p>
              <a href={`/api/jobber/connect?location_id=${location.Location_ID}`} style={{ display: 'inline-block', padding: '8px 16px', background: 'var(--brand)', color: '#000', borderRadius: '6px', textDecoration: 'none', fontSize: '13px', fontWeight: 600 }}>
                Connect Jobber
              </a>
            </div>
          )}
        </div>
      </div>

      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.25rem', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Paths & Links</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <div>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>Booking Link</p>
            {location.Booking_Link ? <a href={location.Booking_Link} target="_blank" rel="noopener noreferrer" style={{ fontSize: '13px', color: 'var(--brand)', textDecoration: 'none' }}>Open ↗</a> : <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>—</p>}
          </div>
          <div>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>Google Reviews</p>
            {location.Google_Reviews ? <a href={location.Google_Reviews} target="_blank" rel="noopener noreferrer" style={{ fontSize: '13px', color: 'var(--brand)', textDecoration: 'none' }}>Open ↗</a> : <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>—</p>}
          </div>
          <div>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>Jobber URL</p>
            {location.Jobber_URL ? <a href={location.Jobber_URL} target="_blank" rel="noopener noreferrer" style={{ fontSize: '13px', color: 'var(--brand)', textDecoration: 'none' }}>Open ↗</a> : <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>—</p>}
          </div>
          <div>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>Website</p>
            {location.Website ? <a href={location.Website} target="_blank" rel="noopener noreferrer" style={{ fontSize: '13px', color: 'var(--brand)', textDecoration: 'none' }}>Open ↗</a> : <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>—</p>}
          </div>
          <div>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>FAQ Doc</p>
            {location.FAQ_Doc ? <a href={location.FAQ_Doc} target="_blank" rel="noopener noreferrer" style={{ fontSize: '13px', color: 'var(--brand)', textDecoration: 'none' }}>Open ↗</a> : <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>—</p>}
          </div>
          <div>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>Group ID</p>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{location.Group_ID || '—'}</p>
          </div>
        </div>
      </div>

      {location.Jobber_Account_ID && (
        <ImportSection locationId={location.Location_ID} />
      )}
    </div>
  )
}
