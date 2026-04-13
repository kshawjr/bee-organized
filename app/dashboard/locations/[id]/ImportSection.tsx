'use client'

import { useState } from 'react'

interface ImportResult {
  client: string
  success: boolean
  action: string
  stage?: string
  error?: string
  reason?: string
}

interface ImportStats {
  total_in_jobber: number
  already_imported: number
  remaining_before: number
  remaining_after: number
  batch_size: number
}

interface PreviewStats {
  clients: number
  total: number
  stageBreakdown: [string, number][]
}

function getSizeWarning(clientCount: number): { message: string; level: 'red' | 'yellow' | 'blue' } | null {
  if (clientCount >= 1000) return { message: `Large account — ${clientCount.toLocaleString()} clients. Import runs in batches automatically.`, level: 'red' }
  if (clientCount >= 500) return { message: `${clientCount.toLocaleString()} clients. Import will batch automatically.`, level: 'yellow' }
  if (clientCount >= 200) return { message: `${clientCount.toLocaleString()} clients found.`, level: 'blue' }
  return null
}

function getStageColor(stage: string | null) {
  if (stage === 'Final Processing') return '#22c55e'
  if (stage === 'Job in Progress') return '#3b82f6'
  if (stage === 'Quote') return '#8b5cf6'
  if (stage === 'Assessment Scheduled') return '#f59e0b'
  if (stage === 'Stagnant') return '#6b7280'
  if (stage === 'No contact info') return '#ef4444'
  return '#6b7280'
}

function getActionColor(action: string) {
  if (action === 'created') return '#22c55e'
  if (action === 'synced') return '#3b82f6'
  if (action === 'created_stagnant') return '#f59e0b'
  if (action === 'failed') return '#ef4444'
  return '#6b7280'
}

function getActionLabel(action: string, reason?: string) {
  if (action === 'created') return '+ Created'
  if (action === 'synced') return '↻ Synced'
  if (action === 'created_stagnant') return `~ Stagnant${reason ? ` (${reason})` : ''}`
  if (action === 'failed') return '✗ Failed'
  return action
}

export default function ImportSection({ locationId }: { locationId: string }) {
  const [step, setStep] = useState<'idle' | 'previewing' | 'preview' | 'importing' | 'done'>('idle')
  const [previewStats, setPreviewStats] = useState<PreviewStats | null>(null)
  const [results, setResults] = useState<ImportResult[]>([])
  const [stats, setStats] = useState<ImportStats | null>(null)
  const [progress, setProgress] = useState<{ imported: number; remaining: number; batch: number } | null>(null)
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
      if (data.error) { setError(data.error); setStep('idle') }
      else {
        setPreviewStats({ clients: data.client_count, total: data.total_work_items, stageBreakdown: data.stage_breakdown || [] })
        setStep('preview')
      }
    } catch (err) { setError(String(err)); setStep('idle') }
  }

  async function handleImport() {
    setStep('importing')
    setError('')
    setResults([])
    setProgress(null)

    const allResults: ImportResult[] = []
    let remaining = Infinity
    let batchNum = 0

    while (remaining > 0) {
      batchNum++
      try {
        const res = await fetch('/api/jobber/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ location_id: locationId, batch_size: 100 }),
        })
        const data = await res.json()

        if (data.error) { setError(data.error); setStep('done'); setResults([...allResults]); return }

        allResults.push(...(data.results || []))
        remaining = data.remaining_after

        setProgress({ imported: data.already_imported + allResults.length, remaining, batch: batchNum })
        setStats({ total_in_jobber: data.total_in_jobber, already_imported: data.already_imported, remaining_before: data.remaining_before, remaining_after: remaining, batch_size: data.batch_size })
        setResults([...allResults])

        if (remaining === 0) break
        await new Promise(r => setTimeout(r, 1000))
      } catch (err) { setError(String(err)); setStep('done'); setResults([...allResults]); return }
    }

    setStep('done')
  }

  function reset() {
    setStep('idle'); setResults([]); setStats(null); setPreviewStats(null); setProgress(null); setError('')
  }

  const warning = previewStats ? getSizeWarning(previewStats.clients) : null
  const maxStageCount = previewStats?.stageBreakdown[0]?.[1] || 1
  const created = results.filter(r => r.action === 'created').length
  const synced = results.filter(r => r.action === 'synced').length
  const stagnant = results.filter(r => r.action === 'created_stagnant').length
  const failed = results.filter(r => !r.success).length
  const isDone = step === 'done'
  const isComplete = isDone && stats?.remaining_after === 0

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1.25rem', marginTop: '0.25rem' }}>

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: step === 'idle' ? 0 : '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ width: '3px', height: '14px', background: isDone && isComplete ? '#22c55e' : step === 'importing' ? '#3b82f6' : '#d4a046', borderRadius: '2px' }} />
          <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>
            Jobber Import
          </span>
          {step === 'importing' && progress && (
            <span style={{ fontSize: '11px', color: '#3b82f6', background: 'rgba(59,130,246,0.1)', padding: '2px 8px', borderRadius: '20px' }}>
              Batch {progress.batch} running...
            </span>
          )}
          {isDone && (
            <span style={{ fontSize: '11px', color: isComplete ? '#22c55e' : '#f59e0b', background: isComplete ? 'rgba(34,197,94,0.1)' : 'rgba(245,158,11,0.1)', padding: '2px 8px', borderRadius: '20px' }}>
              {isComplete ? '✓ Complete' : '⚠ Incomplete'}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          {step === 'idle' && (
            <button onClick={handlePreview} style={{ padding: '7px 16px', background: '#1a2e2b', color: 'white', border: 'none', borderRadius: '7px', fontSize: '13px', fontWeight: 500, cursor: 'pointer' }}>
              Preview Import
            </button>
          )}
          {step === 'preview' && (
            <>
              <button onClick={reset} style={{ padding: '7px 14px', background: 'transparent', border: '1px solid var(--border)', borderRadius: '7px', fontSize: '13px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={handleImport} style={{ padding: '7px 16px', background: '#1a2e2b', color: 'white', border: 'none', borderRadius: '7px', fontSize: '13px', fontWeight: 500, cursor: 'pointer' }}>
                Run Full Import
              </button>
            </>
          )}
          {isDone && (
            <button onClick={reset} style={{ padding: '7px 14px', background: 'transparent', border: '1px solid var(--border)', borderRadius: '7px', fontSize: '13px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: '10px 14px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px', marginBottom: '1rem' }}>
          <p style={{ fontSize: '13px', color: '#ef4444' }}>{error}</p>
        </div>
      )}

      {/* Previewing state */}
      {step === 'previewing' && (
        <div style={{ padding: '1.5rem', background: 'var(--bg-elevated)', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '24px', marginBottom: '8px' }}>⏳</div>
          <p style={{ fontSize: '14px', fontWeight: 500, marginBottom: '4px' }}>Fetching Jobber records...</p>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>This may take a minute for large accounts. Please don't close this page.</p>
        </div>
      )}

      {/* Importing state */}
      {step === 'importing' && (
        <div>
          {progress && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1px', background: 'var(--border)', borderRadius: '8px', overflow: 'hidden', marginBottom: '1rem' }}>
              {[
                { label: 'Total in Jobber', value: stats?.total_in_jobber.toLocaleString() || '—', color: 'var(--text-primary)' },
                { label: 'Imported', value: progress.imported.toLocaleString(), color: '#22c55e' },
                { label: 'Remaining', value: progress.remaining.toLocaleString(), color: progress.remaining > 0 ? '#f59e0b' : '#22c55e' },
              ].map(item => (
                <div key={item.label} style={{ padding: '14px', background: 'var(--bg-elevated)', textAlign: 'center' }}>
                  <p style={{ fontSize: '22px', fontWeight: 700, color: item.color, lineHeight: 1, marginBottom: '4px' }}>{item.value}</p>
                  <p style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{item.label}</p>
                </div>
              ))}
            </div>
          )}
          <p style={{ fontSize: '12px', color: '#f59e0b', textAlign: 'center', marginBottom: '1rem' }}>
            ⚠ Import running — do not close this page
          </p>
        </div>
      )}

      {/* Preview state */}
      {step === 'preview' && previewStats && (
        <div>
          {warning && (
            <div style={{ padding: '10px 14px', background: warning.level === 'red' ? 'rgba(239,68,68,0.08)' : warning.level === 'yellow' ? 'rgba(245,158,11,0.08)' : 'rgba(59,130,246,0.08)', borderRadius: '8px', marginBottom: '1rem', border: `1px solid ${warning.level === 'red' ? 'rgba(239,68,68,0.2)' : warning.level === 'yellow' ? 'rgba(245,158,11,0.2)' : 'rgba(59,130,246,0.2)'}` }}>
              <p style={{ fontSize: '12px', color: warning.level === 'red' ? '#ef4444' : warning.level === 'yellow' ? '#f59e0b' : '#3b82f6' }}>{warning.message}</p>
            </div>
          )}

          <div style={{ display: 'grid', gap: '6px', marginBottom: '1rem' }}>
            {previewStats.stageBreakdown.map(([stage, count]) => (
              <div key={stage} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: '90px', fontSize: '11px', color: getStageColor(stage), fontWeight: 500, flexShrink: 0 }}>{stage}</div>
                <div style={{ flex: 1, height: '6px', background: 'var(--bg-elevated)', borderRadius: '3px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(count / maxStageCount) * 100}%`, background: getStageColor(stage), borderRadius: '3px', opacity: 0.7 }} />
                </div>
                <div style={{ fontSize: '12px', fontWeight: 600, width: '40px', textAlign: 'right' }}>{count.toLocaleString()}</div>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '8px', borderTop: '1px solid var(--border)', marginTop: '4px' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Total work items</span>
              <span style={{ fontSize: '13px', fontWeight: 700 }}>{previewStats.total.toLocaleString()}</span>
            </div>
          </div>
        </div>
      )}

      {/* Done state */}
      {isDone && stats && (
        <div>
          {/* Stats grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1px', background: 'var(--border)', borderRadius: '8px', overflow: 'hidden', marginBottom: '1rem' }}>
            {[
              { label: 'Total in Jobber', value: stats.total_in_jobber.toLocaleString(), color: 'var(--text-primary)' },
              { label: 'This Run', value: results.length.toLocaleString(), color: '#22c55e' },
              { label: 'Remaining', value: stats.remaining_after.toLocaleString(), color: stats.remaining_after > 0 ? '#f59e0b' : '#22c55e' },
            ].map(item => (
              <div key={item.label} style={{ padding: '14px', background: 'var(--bg-elevated)', textAlign: 'center' }}>
                <p style={{ fontSize: '22px', fontWeight: 700, color: item.color, lineHeight: 1, marginBottom: '4px' }}>{item.value}</p>
                <p style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{item.label}</p>
              </div>
            ))}
          </div>

          {/* Summary pill row */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '1rem', flexWrap: 'wrap' }}>
            {[
              { count: created, label: 'created', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
              { count: synced, label: 'synced', color: '#3b82f6', bg: 'rgba(59,130,246,0.1)' },
              { count: stagnant, label: 'stagnant', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
              { count: failed, label: 'failed', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
            ].map(item => (
              <div key={item.label} style={{ padding: '4px 12px', background: item.bg, borderRadius: '20px', fontSize: '12px', color: item.color, fontWeight: 500 }}>
                {item.count} {item.label}
              </div>
            ))}
          </div>

          {/* Results list */}
          {results.length > 0 && (
            <div style={{ maxHeight: '220px', overflowY: 'auto', borderRadius: '8px', border: '1px solid var(--border)', overflow: 'hidden' }}>
              {results.map((result, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 12px', background: i % 2 === 0 ? 'var(--bg-elevated)' : 'transparent', borderBottom: i < results.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <span style={{ fontSize: '12px' }}>{result.client}</span>
                  <span style={{ fontSize: '11px', color: getActionColor(result.action), fontWeight: 500, flexShrink: 0, marginLeft: '1rem' }}>
                    {getActionLabel(result.action, result.reason)}{result.stage ? ` — ${result.stage}` : ''}{result.error ? ` — ${result.error}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}