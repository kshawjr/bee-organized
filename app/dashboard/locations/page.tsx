'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
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
}

const STATUS_CONFIG: Record<string, { color: string; bg: string; dot: string }> = {
  Active: { color: '#22c55e', bg: 'rgba(34,197,94,0.1)', dot: '#22c55e' },
  Pending: { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', dot: '#f59e0b' },
  Inactive: { color: '#6b7280', bg: 'rgba(107,114,128,0.1)', dot: '#6b7280' },
}

export default function LocationsPage() {
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
        console.log('locations data:', d)
        console.log('first location:', d.locations?.[0])
        setLocations(d.locations || [])
        setLoading(false)
      })
  }, [])

  const filtered = locations.filter(l => {
    const matchSearch = !search ||
      l.Name.toLowerCase().includes(search.toLowerCase()) ||
      l.Location_ID.toLowerCase().includes(search.toLowerCase()) ||
      (l.Group_Email || '').toLowerCase().includes(search.toLowerCase())
    const matchStatus = !statusFilter || l.CRM_Status === statusFilter
    const matchJobber = !jobberFilter ||
      (jobberFilter === 'connected' && l.Jobber_Account_ID) ||
      (jobberFilter === 'not_connected' && !l.Jobber_Account_ID)
    return matchSearch && matchStatus && matchJobber
  })

  const statusOrder = ['Active', 'Pending', 'Inactive']
  const grouped = statusOrder.reduce((acc, status) => {
    const group = filtered
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

      {/* Filters */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem' }}>
        <input
          type="text"
          placeholder="Search by name, ID, or email..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            flex: 1,
            padding: '8px 12px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            color: 'var(--text-primary)',
            fontSize: '14px',
            outline: 'none',
          }}
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
            style={{
              padding: '8px 12px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              color: 'var(--text-secondary)',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            Clear
          </button>
        )}
      </div>

      {loading ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Loading locations...</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {Object.entries(grouped).map(([status, locs]) => {
            const config = STATUS_CONFIG[status] || { color: 'var(--text-muted)', bg: 'var(--bg-elevated)', dot: 'var(--text-muted)' }
            const isCollapsed = collapsed[status]

            return (
              <div key={status} style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden', background: 'var(--bg-card)' }}>
                <button
                  onClick={() => toggleGroup(status)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '12px 16px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: isCollapsed ? 'none' : '1px solid var(--border)',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: config.dot, display: 'inline-block', flexShrink: 0 }}></span>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: config.color, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {status}
                  </span>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '1px 7px', borderRadius: '20px' }}>
                    {locs.length}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: '12px', color: 'var(--text-muted)' }}>
                    {isCollapsed ? '▸' : '▾'}
                  </span>
                </button>

                {!isCollapsed && (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Name</th>
                        <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Location ID</th>
                        <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Timezone</th>
                        <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Jobber</th>
                        <th style={{ padding: '8px 16px' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {locs.map(location => (
                        <tr key={location.id} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '12px 16px' }}>
                            <div style={{ fontSize: '14px', fontWeight: 500 }}>{location.Name}</div>
                            {location.Group_Email && (
                              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{location.Group_Email}</div>
                            )}
                          </td>
                          <td style={{ padding: '12px 16px' }}>
                            <code style={{ fontSize: '12px', background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: '4px', color: 'var(--text-secondary)' }}>
                              {location.Location_ID}
                            </code>
                          </td>
                          <td style={{ padding: '12px 16px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                            {location.Time_Zone || '—'}
                          </td>
                          <td style={{ padding: '12px 16px' }}>
                            {location.Jobber_Account_ID
                              ? <span style={{ fontSize: '12px', color: '#22c55e', background: 'rgba(34,197,94,0.1)', padding: '2px 8px', borderRadius: '20px' }}>Connected</span>
                              : location.Configure_Location_to_Jobber
                                ? <span style={{ fontSize: '12px', color: '#f59e0b', background: 'rgba(245,158,11,0.1)', padding: '2px 8px', borderRadius: '20px' }}>Ready</span>
                                : <span style={{ fontSize: '12px', color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '2px 8px', borderRadius: '20px' }}>Not configured</span>
                            }
                          </td>
                          <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                            <Link href={`/dashboard/locations/${location.Location_ID}`} style={{ fontSize: '13px', color: 'var(--brand)', textDecoration: 'none' }}>
                              Manage →
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}

          {Object.keys(grouped).length === 0 && (
            <p style={{ color: 'var(--text-muted)', fontSize: '14px', textAlign: 'center', padding: '3rem' }}>
              No locations match your filters.
            </p>
          )}
        </div>
      )}
    </div>
  )
}