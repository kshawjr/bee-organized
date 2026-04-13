'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import SearchSelect from '@/components/SearchSelect'

interface Location {
  id: string
  Name: string
  Location_ID: string
  Time_Zone: string
  CRM_Status: string
  Jobber_Account_ID: string | null
  Configure_Location_to_Jobber: boolean
  Group_Email: string | null
  Phone_Number: string | null
  Owner?: { name: string } | null
}

const STATUS_CONFIG: Record<string, { color: string; dot: string }> = {
  Active: { color: '#22c55e', dot: '#22c55e' },
  Pending: { color: '#f59e0b', dot: '#f59e0b' },
  Inactive: { color: '#6b7280', dot: '#6b7280' },
}

function JobberBadge({ location }: { location: Location }) {
  if (location.Jobber_Account_ID)
    return <span style={{ fontSize: '12px', color: '#22c55e', background: 'rgba(34,197,94,0.1)', padding: '2px 8px', borderRadius: '20px' }}>Connected</span>
  if (location.Configure_Location_to_Jobber)
    return <span style={{ fontSize: '12px', color: '#f59e0b', background: 'rgba(245,158,11,0.1)', padding: '2px 8px', borderRadius: '20px' }}>Ready</span>
  return <span style={{ fontSize: '12px', color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '2px 8px', borderRadius: '20px' }}>Not configured</span>
}

function LocationRow({ location, onClick }: { location: Location; onClick: () => void }) {
  const [hovered, setHovered] = useState(false)

  return (
    <tr
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer', background: hovered ? 'var(--bg-elevated)' : 'transparent', transition: 'background 0.1s' }}
    >
      <td style={{ padding: '10px 16px' }}>
        <div style={{ fontSize: '14px', fontWeight: 500, color: hovered ? 'var(--brand)' : 'var(--text-primary)', transition: 'color 0.1s' }}>{location.Name}</div>
        {location.Owner?.name && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{location.Owner.name}</div>}
      </td>
      <td style={{ padding: '10px 16px' }}>
        <code style={{ fontSize: '12px', background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: '4px', color: 'var(--text-secondary)' }}>
          {location.Location_ID}
        </code>
      </td>
      <td style={{ padding: '10px 16px', fontSize: '13px', color: 'var(--text-secondary)' }}>
        {location.Time_Zone || '—'}
      </td>
      <td style={{ padding: '10px 16px' }}>
        <JobberBadge location={location} />
      </td>
    </tr>
  )
}

export default function LocationsPage() {
  const router = useRouter()
  const [locations, setLocations] = useState<Location[]>([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [jobberFilter, setJobberFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    Active: false,
    Pending: true,
    Inactive: true,
  })

  useEffect(() => {
    fetch('/api/zoho/locations')
      .then(r => r.json())
      .then(d => {
        setLocations(d.locations || [])
        setLoading(false)
      })
  }, [])

  const filtered = locations.filter(l => {
    const matchSearch = !search ||
      l.Name.toLowerCase().includes(search.toLowerCase()) ||
      l.Location_ID.toLowerCase().includes(search.toLowerCase()) ||
      (l.Group_Email || '').toLowerCase().includes(search.toLowerCase()) ||
      (l.Owner?.name || '').toLowerCase().includes(search.toLowerCase())
    const matchStatus = !statusFilter || l.CRM_Status === statusFilter
    const matchJobber = !jobberFilter ||
      (jobberFilter === 'connected' && l.Jobber_Account_ID) ||
      (jobberFilter === 'not_connected' && !l.Jobber_Account_ID)
    return matchSearch && matchStatus && matchJobber
  })

  const pinned = filtered.filter(l => l.Location_ID === 'loc_test')
  const rest = filtered.filter(l => l.Location_ID !== 'loc_test')

  const statusOrder = ['Active', 'Pending', 'Inactive']
  const grouped = statusOrder.reduce((acc, status) => {
    const group = rest
      .filter(l => l.CRM_Status === status)
      .sort((a, b) => a.Name.localeCompare(b.Name))
    if (group.length > 0) acc[status] = group
    return acc
  }, {} as Record<string, Location[]>)

  const total = locations.length
  const active = locations.filter(l => l.CRM_Status === 'Active').length
  const pending = locations.filter(l => l.CRM_Status === 'Pending').length
  const connected = locations.filter(l => l.Jobber_Account_ID).length

  function toggleGroup(status: string) {
    setCollapsed(prev => ({ ...prev, [status]: !prev[status] }))
  }

  function navigate(locationId: string) {
    router.push(`/dashboard/locations/${locationId}`)
  }

  const colWidths = ['auto', '140px', '180px', '140px']

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '4px' }}>Locations</h1>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{total} total</span>
          <span style={{ fontSize: '13px', color: '#22c55e' }}>● {active} active</span>
          <span style={{ fontSize: '13px', color: '#f59e0b' }}>● {pending} pending</span>
          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>⚡ {connected} Jobber connected</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem', position: 'relative', zIndex: 10 }}>
        <input
          type="text"
          placeholder="Search by name, ID, owner, or email..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid #d0d0d0', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '14px', outline: 'none' }}
        />
        <SearchSelect
          options={[
            { value: 'Active', label: '● Active' },
            { value: 'Pending', label: '● Pending' },
            { value: 'Inactive', label: '● Inactive' },
          ]}
          value={statusFilter}
          onChange={setStatusFilter}
          placeholder="CRM Status"
          width="160px"
        />
        <SearchSelect
          options={[
            { value: 'connected', label: '⚡ Connected' },
            { value: 'not_connected', label: '— Not connected' },
          ]}
          value={jobberFilter}
          onChange={setJobberFilter}
          placeholder="Jobber"
          width="160px"
        />
        {(search || statusFilter || jobberFilter) && (
          <button
            onClick={() => { setSearch(''); setStatusFilter(''); setJobberFilter('') }}
            style={{ padding: '8px 12px', background: 'var(--bg-elevated)', border: '1px solid #d0d0d0', borderRadius: '6px', color: 'var(--text-secondary)', fontSize: '13px', cursor: 'pointer' }}
          >
            Clear
          </button>
        )}
      </div>

      {loading ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Loading locations...</p>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'visible', background: 'var(--bg-card)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <colgroup>
              {colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}
            </colgroup>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Name', 'Location ID', 'Timezone', 'Jobber'].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Pinned */}
              {pinned.length > 0 && (
                <>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <td colSpan={4} style={{ padding: '6px 16px', background: 'rgba(212,160,70,0.05)' }}>
                      <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--brand)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>📌 Test</span>
                    </td>
                  </tr>
                  {pinned.map(location => (
                    <LocationRow key={location.id} location={location} onClick={() => navigate(location.Location_ID)} />
                  ))}
                </>
              )}

              {/* Grouped */}
              {Object.entries(grouped).map(([status, locs]) => {
                const config = STATUS_CONFIG[status] || { color: 'var(--text-muted)', dot: 'var(--text-muted)' }
                const isCollapsed = collapsed[status]

                return (
                  <>
                    <tr key={`header-${status}`} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => toggleGroup(status)}>
                      <td colSpan={4} style={{ padding: '8px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: config.dot, display: 'inline-block' }} />
                          <span style={{ fontSize: '12px', fontWeight: 600, color: config.color, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{status}</span>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '1px 6px', borderRadius: '20px' }}>{locs.length}</span>
                          <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text-muted)' }}>{isCollapsed ? '▸' : '▾'}</span>
                        </div>
                      </td>
                    </tr>
                    {!isCollapsed && locs.map(location => (
                      <LocationRow key={location.id} location={location} onClick={() => navigate(location.Location_ID)} />
                    ))}
                  </>
                )
              })}

              {pinned.length === 0 && Object.keys(grouped).length === 0 && (
                <tr>
                  <td colSpan={4} style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '14px' }}>
                    No locations match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}