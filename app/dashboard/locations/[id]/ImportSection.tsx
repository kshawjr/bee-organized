'use client'

import { useState } from 'react'

interface PreviewRecord {
  name: string
  email?: string
  requests: Array<{
    id: string
    stage: string | null
    date: string
    jobberJobId: string | null
    jobberQuoteId: string | null
  }>
}

interface ImportResult {
  client: string
  success: boolean
  action: string
  stage?: string
  error?: string
}

export default function ImportSection({ locationId }: { locationId: string }) {
  const [step, setStep] = useState<'idle' | 'previewing' | 'preview' | 'importing' | 'done'>('idle')
  const [preview, setPreview] = useState<PreviewRecord[]>([])
  const [results, setResults] = useState<ImportResult[]>([])
  const [error, setError] = useState('')

  async function handlePreview() {
    setStep('previewing')
    setError('')
    try {
      const res = await fetch('/api/jobber/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, dry_run: true }),
      })
      const data = await res.json()
      if (data.error) {
        setError(data.error)
        setStep('idle')
      } else {
        setPreview(data.preview || [])
        setStep('preview')
      }
    } catch (err) {
      setError(String(err))
      setStep('idle')
    }
  }

  async function handleImport() {
    setStep('importing')
    setError('')
    try {
      const res = await fetch('/api/jobber/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId }),
      })
      const data = await res.json()
      if (data.error) {
        setError(data.error)
        setStep('preview')
      } else {
        setResults(data.results || [])
        setStep('done')
      }
    } catch (err) {
      setError(String(err))
      setStep('preview')
    }
  }

  function getStageColor(stage: string | null) {
    if (!stage) return 'var(--text-muted)'
    if (stage === 'Final Processing') return '#22c55e'
    if (stage === 'Job in Progress') return '#3b82f6'
    if (stage === 'Quote') return '#8b5cf6'
    if (stage === 'Assessment Scheduled') return '#f59e0b'
    return 'var(--text-muted)'
  }

  function getActionColor(action: string) {
    if (action === 'created') return '#22c55e'
    if (action === 'synced') return '#3b82f6'
    if (action === 'created_stagnant') return '#f59e0b'
    if (action === 'failed') return '#ef4444'
    return 'var(--text-muted)'
  }

  function getActionLabel(action: string) {
    if (action === 'created') return '+ Created'
    if (action === 'synced') return '↻ Synced'
    if (action === 'created_stagnant') return '~ Stagnant'
    if (action === 'failed') return '✗ Failed'
    return action
  }

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Jobber Import
        </h2>
        {step === 'idle' && (
          <button
            onClick={handlePreview}
            style={{ padding: '6px 14px', background: 'var(--brand)', color: '#000', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
          >
            Preview Import
          </button>
        )}
        {step === 'preview' && (
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => setStep('idle')}
              style={{ padding: '6px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '13px', color: 'var(--text-secondary)', cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              onClick={handleImport}
              style={{ padding: '6px 14px', background: 'var(--brand)', color: '#000', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
            >
              Run Import
            </button>
          </div>
        )}
        {step === 'done' && (
          <button
            onClick={() => { setStep('idle'); setResults([]); setPreview([]) }}
            style={{ padding: '6px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '13px', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            Reset
          </button>
        )}
      </div>

      {error && (
        <p style={{ fontSize: '13px', color: '#ef4444', padding: '8px 12px', background: 'rgba(239,68,68,0.1)', borderRadius: '6px', marginBottom: '1rem' }}>
          {error}
        </p>
      )}

      {step === 'previewing' && (
        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Loading preview...</p>
      )}

      {step === 'importing' && (
        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Importing... this may take a minute.</p>
      )}

      {step === 'preview' && (
        <div>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            {preview.length} clients found. Review before importing:
          </p>
          <div style={{ display: 'grid', gap: '6px', maxHeight: '300px', overflowY: 'auto' }}>
            {preview.map((record, i) => (
              <div key={i} style={{ padding: '10px 12px', background: 'var(--bg-elevated)', borderRadius: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <p style={{ fontSize: '13px', fontWeight: 500 }}>{record.name}</p>
                    {record.email && <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{record.email}</p>}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {record.requests.length === 0 ? (
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', background: 'var(--bg-card)', padding: '2px 8px', borderRadius: '20px' }}>No requests</span>
                    ) : (
                      record.requests.map((req, j) => (
                        <span key={j} style={{ fontSize: '11px', color: getStageColor(req.stage), background: 'var(--bg-card)', padding: '2px 8px', borderRadius: '20px', display: 'block' }}>
                          {req.stage || 'Stagnant'}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {step === 'done' && (
        <div>
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
            <span style={{ fontSize: '13px', color: '#22c55e' }}>✓ {results.filter(r => r.action === 'created').length} created</span>
            <span style={{ fontSize: '13px', color: '#3b82f6' }}>↻ {results.filter(r => r.action === 'synced').length} synced</span>
            <span style={{ fontSize: '13px', color: '#f59e0b' }}>~ {results.filter(r => r.action === 'created_stagnant').length} stagnant</span>
            <span style={{ fontSize: '13px', color: '#ef4444' }}>✗ {results.filter(r => !r.success).length} failed</span>
          </div>
          <div style={{ display: 'grid', gap: '4px', maxHeight: '300px', overflowY: 'auto' }}>
            {results.map((result, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--bg-elevated)', borderRadius: '6px' }}>
                <span style={{ fontSize: '13px' }}>{result.client}</span>
                <span style={{ fontSize: '12px', color: getActionColor(result.action), fontWeight: 500 }}>
                  {getActionLabel(result.action)}
                  {result.stage ? ` — ${result.stage}` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}