'use client'

import { useState, useEffect } from 'react'

interface SyncEntry {
  id: string
  location_id: string
  entity_id: string
  direction: string
  entity_type: string
  status: string
  message: string
  zoho_record_id: string
  jobber_record_id: string
  created_at: string
}

const PAGE_SIZE = 50

export default function SyncLogPage() {
  const [logs, setLogs] = useState<SyncEntry[]>([])
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchLogs()
  }, [page, search])

  async function fetchLogs() {
    setLoading(true)
    const params = new URLSearchParams({
      page: page.toString(),
      search,
    })
    const res = await fetch(`/api/sync-log?${params}`)
    const data = await res.json()
    setLogs(data.logs || [])
    setTotal(data.total || 0)
    setLoading(false)
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  function getStatusColor(status: string) {
    if (status === 'success') return '#22c55e'
    if (status === 'error') return '#ef4444'
    return '#f59e0b'
  }

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '4px' }}>Sync Log</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
          {total.toLocaleString()} total records
        </p>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
        <input
          type="text"
          placeholder="Search by client name..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(0) }}
          style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '14px', outline: 'none' }}
        />
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden', background: 'var(--bg-card)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['Time', 'Client', 'Location', 'Status', 'Message'].map(h => (
                <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '14px' }}>
                  Loading...
                </td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '14px' }}>
                  {search ? 'No results found.' : 'No sync activity yet.'}
                </td>
              </tr>
            ) : logs.map(log => (
              <tr key={log.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '10px 16px', fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {new Date(log.created_at).toLocaleString()}
                </td>
                <td style={{ padding: '10px 16px', fontSize: '13px', fontWeight: 500 }}>
                  {log.entity_id || '—'}
                </td>
                <td style={{ padding: '10px 16px' }}>
                  <code style={{ fontSize: '11px', background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: '4px', color: 'var(--text-secondary)' }}>
                    {log.location_id}
                  </code>
                </td>
                <td style={{ padding: '10px 16px' }}>
                  <span style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: '20px',
                    background: log.status === 'success' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                    color: getStatusColor(log.status),
                    fontWeight: 500,
                  }}>
                    {log.status}
                  </span>
                </td>
                <td style={{ padding: '10px 16px', fontSize: '12px', color: 'var(--text-secondary)', maxWidth: '300px' }}>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {log.message || '—'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem' }}>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            Page {page + 1} of {totalPages}
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              style={{ padding: '6px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '13px', color: page === 0 ? 'var(--text-muted)' : 'var(--text-primary)', cursor: page === 0 ? 'not-allowed' : 'pointer' }}
            >
              ← Prev
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              style={{ padding: '6px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '13px', color: page >= totalPages - 1 ? 'var(--text-muted)' : 'var(--text-primary)', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}