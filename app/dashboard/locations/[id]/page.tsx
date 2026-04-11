import { requireAuth } from '@/lib/auth'
import { getZohoLocation } from '@/lib/zoho'
import { notFound } from 'next/navigation'
import Link from 'next/link'

interface Props {
  params: { id: string }
}

export default async function LocationDetailPage({ params }: Props) {
  await requireAuth()
const location = await getZohoLocation(params.id)

  if (!location) notFound()

  return (
    <div style={{ maxWidth: '800px' }}>
      <Link href="/dashboard/locations" style={{ fontSize: '13px', color: 'var(--text-muted)', textDecoration: 'none', marginBottom: '1.5rem', display: 'block' }}>
        ← Back to locations
      </Link>

      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '8px' }}>{location.Name}</h1>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <code style={{ fontSize: '12px', background: 'var(--bg-elevated)', padding: '3px 8px', borderRadius: '6px', color: 'var(--text-secondary)' }}>
            {location.Location_ID}
          </code>
          <span style={{
            fontSize: '12px',
            padding: '2px 8px',
            borderRadius: '20px',
            background: location.CRM_Status === 'Active' ? 'rgba(34,197,94,0.1)' : 'var(--bg-elevated)',
            color: location.CRM_Status === 'Active' ? 'var(--success)' : 'var(--text-muted)',
          }}>
            {location.CRM_Status}
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>

        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.25rem' }}>
          <h2 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Details</h2>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
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
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--success)', display: 'inline-block' }}></span>
                <span style={{ fontSize: '14px', color: 'var(--success)', fontWeight: 500 }}>Connected</span>
              </div>
              <div>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>Last Sync</p>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{location.Last_Sync_Status || '—'}</p>
              </div>
              <div style={{ marginTop: '0.75rem' }}>
<p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>Token Expiry</p>
<p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
  {location.Token_Expiry ? new Date(parseInt(location.Token_Expiry)).toLocaleString() : '—'}
</p>
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
    </div>
  )
}