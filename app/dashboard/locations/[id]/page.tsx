import { requireAuth } from '@/lib/auth'
import { getZohoLocation } from '@/lib/zoho'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import ImportSection from './ImportSection'

interface Props {
  params: { id: string }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <p style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', fontWeight: 500 }}>{label}</p>
      <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{children}</div>
    </div>
  )
}

function LinkField({ label, url }: { label: string; url?: string | null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 500 }}>{label}</span>
      {url
        ? <a href={url} target="_blank" rel="noopener noreferrer" style={{
            fontSize: '13px', color: '#1a2e2b', background: 'rgba(168,201,196,0.15)',
            border: '1px solid rgba(168,201,196,0.3)', padding: '3px 10px',
            borderRadius: '20px', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 500
          }}>
            Open <span>↗</span>
          </a>
        : <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>—</span>
      }
    </div>
  )
}

export default async function LocationDetailPage({ params }: Props) {
  await requireAuth()
  const location = await getZohoLocation(params.id)
  if (!location) notFound()

  const tokenExpiry = location.Token_Expiry ? parseInt(location.Token_Expiry) : 0
  const remaining = tokenExpiry - Date.now()
  const tokenValid = tokenExpiry && remaining > 0
  const tokenColor = !tokenExpiry ? 'var(--text-muted)' : remaining < 5 * 60 * 1000 ? '#ef4444' : remaining < 15 * 60 * 1000 ? '#f59e0b' : '#22c55e'
  const isActive = location.CRM_Status === 'Active'
  const isConnected = !!location.Jobber_Account_ID

  // Get initials for avatar
  const initials = location.Name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()

  return (
    <div style={{ maxWidth: '900px' }}>
      <Link href="/dashboard/locations" style={{ fontSize: '13px', color: 'var(--text-muted)', textDecoration: 'none', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '6px', width: 'fit-content' }}>
        ← Back to locations
      </Link>

      {/* Hero Header */}
      <div style={{
        background: 'linear-gradient(135deg, #1a2e2b 0%, #2a4a46 100%)',
        borderRadius: '12px',
        padding: '2rem',
        marginBottom: '1.25rem',
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* Hex pattern background */}
        <div style={{
          position: 'absolute', inset: 0, opacity: 0.05,
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='70' viewBox='0 0 60 70'%3E%3Cpolygon points='30,2 58,17 58,47 30,62 2,47 2,17' fill='none' stroke='%23a8c9c4' stroke-width='1'/%3E%3C/svg%3E")`,
          backgroundSize: '60px 70px',
        }} />

        <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: '1.25rem' }}>
          {/* Avatar */}
          <div style={{
            width: '56px', height: '56px', borderRadius: '12px',
            background: 'rgba(168,201,196,0.2)', border: '1px solid rgba(168,201,196,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '20px', fontWeight: 700, color: '#a8c9c4', flexShrink: 0,
            fontFamily: 'Playfair Display, serif',
          }}>
            {initials}
          </div>

          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px', flexWrap: 'wrap' }}>
              <h1 style={{ fontSize: '22px', fontWeight: 700, color: 'white', margin: 0 }}>{location.Name}</h1>
              <span style={{
                fontSize: '11px', padding: '2px 10px', borderRadius: '20px', fontWeight: 500,
                background: isActive ? 'rgba(34,197,94,0.2)' : 'rgba(245,158,11,0.2)',
                color: isActive ? '#4ade80' : '#fbbf24',
                border: `1px solid ${isActive ? 'rgba(34,197,94,0.3)' : 'rgba(245,158,11,0.3)'}`,
              }}>
                {location.CRM_Status}
              </span>
            </div>
            {location.Owner?.name && (
              <p style={{ fontSize: '13px', color: 'rgba(168,201,196,0.7)', margin: 0 }}>{location.Owner.name}</p>
            )}
          </div>

          {/* Right side stats */}
          <div style={{ display: 'flex', gap: '1.5rem', flexShrink: 0 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '10px', color: 'rgba(168,201,196,0.5)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Jobber</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: isConnected ? '#4ade80' : '#6b7280', display: 'inline-block' }} />
                <span style={{ fontSize: '13px', color: isConnected ? '#4ade80' : '#9ca3af', fontWeight: 500 }}>{isConnected ? 'Connected' : 'Not set up'}</span>
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '10px', color: 'rgba(168,201,196,0.5)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Token</div>
              <span style={{ fontSize: '13px', color: tokenValid ? '#4ade80' : '#f87171', fontWeight: 500 }}>
                {!tokenExpiry ? '—' : tokenValid ? `${Math.round(remaining / 60000)}m` : 'Expired'}
              </span>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '10px', color: 'rgba(168,201,196,0.5)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Zone</div>
              <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.8)' }}>{location.Time_Zone?.replace('America/', '') || '—'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Details + Paths row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>

        {/* Details card */}
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '3px', height: '14px', background: '#a8c9c4', borderRadius: '2px' }} />
            <h2 style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', margin: 0 }}>Details</h2>
          </div>
          <div style={{ padding: '16px', display: 'grid', gap: '12px' }}>
            <Field label="Location ID">
              <code style={{ fontSize: '12px', background: 'var(--bg-elevated)', padding: '2px 8px', borderRadius: '4px', color: 'var(--text-secondary)' }}>{location.Location_ID}</code>
            </Field>
            <Field label="Phone">{location.Phone_Number || '—'}</Field>
            <Field label="Group Email">{location.Group_Email || '—'}</Field>
            <Field label="Group ID">{location.Group_ID || '—'}</Field>
          </div>
        </div>

        {/* Paths & Links card */}
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '3px', height: '14px', background: '#d4a046', borderRadius: '2px' }} />
            <h2 style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', margin: 0 }}>Paths & Links</h2>
          </div>
          <div style={{ padding: '0 16px 8px' }}>
            <LinkField label="Booking Link" url={location.Booking_Link} />
            <LinkField label="Google Reviews" url={location.Google_Reviews} />
            <LinkField label="Jobber URL" url={location.Jobber_URL} />
            <LinkField label="Website" url={location.Website} />
            <LinkField label="FAQ Doc" url={location.FAQ_Doc} />
          </div>
        </div>
      </div>

      {/* Jobber card */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '3px', height: '14px', background: isConnected ? '#22c55e' : '#6b7280', borderRadius: '2px' }} />
            <h2 style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', margin: 0 }}>Jobber</h2>
          </div>
          {isConnected && (
<a href={`/api/jobber/connect?location_id=${location.Location_ID}`} style={{ fontSize: '12px', color: 'white', textDecoration: 'none', padding: '5px 12px', background: '#1a2e2b', borderRadius: '7px', fontWeight: 500 }}>
  Reconnect
</a>
          )}
        </div>

        {isConnected ? (
          <div style={{ padding: '16px' }}>
            {/* Token/connection summary bar */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1px', background: 'var(--border)', borderRadius: '8px', overflow: 'hidden', marginBottom: '1.25rem' }}>
              {[
                { label: 'Account ID', value: <code style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{location.Jobber_Account_ID?.slice(0, 20)}...</code> },
                { label: 'Token', value: <span style={{ color: tokenColor, fontWeight: 500 }}>{!tokenExpiry ? '—' : tokenValid ? `Valid · ${Math.round(remaining / 60000)}m left` : 'Expired'}</span> },
                { label: 'Last Sync', value: <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{location.Last_Sync_Status?.slice(0, 35) || '—'}</span> },
              ].map(item => (
                <div key={item.label} style={{ padding: '12px 14px', background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 500 }}>{item.label}</span>
                  <div style={{ fontSize: '13px' }}>{item.value}</div>
                </div>
              ))}
            </div>

            {/* Import section */}
            <ImportSection locationId={location.Location_ID} />
          </div>
        ) : (
          <div style={{ padding: '24px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <p style={{ fontSize: '14px', fontWeight: 500, marginBottom: '4px' }}>Not connected to Jobber</p>
              <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Connect to enable imports and sync.</p>
            </div>
            <a
              href={`/api/jobber/connect?location_id=${location.Location_ID}`}
              style={{ padding: '9px 20px', background: '#1a2e2b', color: 'white', borderRadius: '8px', textDecoration: 'none', fontSize: '13px', fontWeight: 500, whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(26,46,43,0.3)' }}
            >
              Connect Jobber →
            </a>
          </div>
        )}
      </div>
    </div>
  )
}