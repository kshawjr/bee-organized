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

function getSizeWarning(clientCount: number, total: number): { message: string; color: string } | null {
  const extra = total - clientCount
  const extraNote = extra > 0 ? ` (${extra.toLocaleString()} clients have multiple requests, adding extra work items)` : ''

  if (clientCount >= 1000) {
    return {
      message: `⚠️ Large account — ${clientCount.toLocaleString()} clients, ${total.toLocaleString()} total records to import${extraNote}. Import will run automatically in batches until complete.`,
      color: '#ef4444'
    }
  }
  if (clientCount >= 500) {
    return {
      message: `⚠️ Medium-large account — ${clientCount.toLocaleString()} clients, ${total.toLocaleString()} total records${extraNote}. Import will run automatically in batches.`,
      color: '#f59e0b'
    }
  }
  if (clientCount >= 200) {
    return {
      message: `ℹ️ ${clientCount.toLocaleString()} clients, ${total.toLocaleString()} total records${extraNote}.`,
      color: '#3b82f6'
    }
  }
  return null
}

function getStageColor(stage: string | null) {
  if (!stage) return 'var(--text-muted)'
  if (stage === 'Final Processing') return '#22c55e'
  if (stage === 'Job in Progress') return '#3b82f6'
  if (stage === 'Quote') return '#8b5cf6'
  if (stage === 'Assessment Scheduled') return '#f59e0b'
  if (stage === 'Stagnant') return 'var(--text-muted)'
  if (stage === 'No contact info') return '#ef4444'
  return 'var(--text-muted)'
}

function getActionColor(action: string) {
  if (action === 'created') return '#22c55e'
  if (action === 'synced') return '#3b82f6'
  if (action === 'created_stagnant') return '#f59e0b'
  if (action === 'failed') return '#ef4444'
  return 'var(--text-muted)'
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
      if (data.error) {
        setError(data.error)
        setStep('idle')
      } else {
        setPreviewStats({
          clients: data.client_count,
          total: data.total_work_items,
          stageBreakdown: data.stage_breakdown || [],
        })
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

        if (data.error) {
          setError(data.error)
          setStep('done')
          setResults([...allResults])
          return
        }

        allResults.push(...(data.results || []))
        remaining = data.remaining_after

        setProgress({
          imported: data.already_imported + allResults.length,
          remaining,
          batch: batchNum,
        })

        setStats({
          total_in_jobber: data.total_in_jobber,
          already_imported: data.already_imported,
          remaining_before: data.remaining_before,
          remaining_after: remaining,
          batch_size: data.batch_size,
        })

        setResults([...allResults])

        if (remaining === 0) break

        await new Promise(r => setTimeout(r, 1000))

      } catch (err) {
        setError(String(err))
        setStep('done')
        setResults([...allResults])
        return
      }
    }

    setStep('done')
  }

  function reset() {
    setStep('idle')
    setResults([])
    setStats(null)
    setPreviewStats(null)
    setProgress(null)
    setError('')
  }

  const warning = previewStats ? getSizeWarning(previewStats.clients, previewStats.total) : null

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Jobber Import
        </h2>
        <div style={{ display: 'flex', gap: '8px' }}>
          {step === 'idle' && (
            <button onClick={handlePreview} style={{ padding: '6px 14px', background: 'var(--brand)', color: '#000', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
              Preview Import
            </button>
          )}
          {step === 'preview' && (
            <>
              <button onClick={reset} style={{ padding: '6px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '13px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={handleImport} style={{ padding: '6px 14px', background: 'var(--brand)', color: '#000', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
                Run Full Import
              </button>
            </>
          )}
          {step === 'done' && (
            <button onClick={reset} style={{ padding: '6px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '13px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              Reset
            </button>
          )}
        </div>
      </div>

      {error && (
        <p style={{ fontSize: '13px', color: '#ef4444', padding: '8px 12px', background: 'rgba(239,68,68,0.1)', borderRadius: '6px', marginBottom: '1rem' }}>
          {error}
        </p>
      )}

      {step === 'previewing' && (
        <div style={{ padding: '1rem 0' }}>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '4px' }}>⏳ Prepping sync...</p>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Fetching all Jobber records and preparing import data.</p>
          <p style={{ fontSize: '12px', color: '#f59e0b' }}>This could take several minutes for large accounts. Please do not close this page.</p>
        </div>
      )}

      {step === 'importing' && (
        <div style={{ padding: '1rem 0' }}>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '4px' }}>⏳ Import running...</p>
          {progress ? (
            <>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                Batch {progress.batch} — {progress.imported.toLocaleString()} imported, {progress.remaining.toLocaleString()} remaining
              </p>
              <p style={{ fontSize: '12px', color: '#f59e0b' }}>Do not close this page. Import will complete automatically.</p>
            </>
          ) : (
            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Starting first batch...</p>
          )}
        </div>
      )}

      {step === 'preview' && previewStats && (
        <div>
          {warning && (
            <div style={{ padding: '10px 12px', background: 'rgba(239,68,68,0.08)', border: `1px solid ${warning.color}30`, borderRadius: '6px', marginBottom: '1rem' }}>
              <p style={{ fontSize: '12px', color: warning.color }}>{warning.message}</p>
            </div>
          )}
          <div style={{ marginBottom: '1rem' }}>
            {previewStats.stageBreakdown.map(([stage, count]) => (
              <div key={stage} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', marginBottom: '3px', background: 'var(--bg-elevated)', borderRadius: '6px' }}>
                <span style={{ fontSize: '13px', color: getStageColor(stage) }}>{stage}</span>
                <span style={{ fontSize: '13px', fontWeight: 600 }}>{count.toLocaleString()}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', marginTop: '4px', borderTop: '1px solid var(--border)' }}>
              <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 500 }}>Total</span>
              <span style={{ fontSize: '13px', fontWeight: 700 }}>{previewStats.total.toLocaleString()}</span>
            </div>
          </div>
        </div>
      )}
{(step === 'importing' || step === 'done') && stats && (
        <div>
          <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '1rem', padding: '10px 12px', background: 'var(--bg-elevated)', borderRadius: '6px' }}>
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: '20px', fontWeight: 700 }}>{stats.total_in_jobber.toLocaleString()}</p>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Total in Jobber</p>
            </div>
            <div style={{ textAlign: 'center' }}>
<p style={{ fontSize: '20px', fontWeight: 700, color: '#22c55e' }}>{results.length.toLocaleString()}</p>
<p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>This run</p>
            </div>
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: '20px', fontWeight: 700, color: stats.remaining_after > 0 ? '#f59e0b' : '#22c55e' }}>
                {stats.remaining_after.toLocaleString()}
              </p>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Remaining</p>
            </div>
          </div>

          {step === 'done' && (
            <div style={{ padding: '10px 12px', borderRadius: '6px', marginBottom: '0.75rem', background: stats.remaining_after === 0 ? 'rgba(34,197,94,0.1)' : 'rgba(245,158,11,0.1)', border: `1px solid ${stats.remaining_after === 0 ? 'rgba(34,197,94,0.3)' : 'rgba(245,158,11,0.3)'}` }}>
              <p style={{ fontSize: '13px', fontWeight: 600, color: stats.remaining_after === 0 ? '#22c55e' : '#f59e0b', marginBottom: '4px' }}>
                {stats.remaining_after === 0 ? '✓ Import Complete' : '⚠️ Import Incomplete'}
              </p>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                {results.filter(r => r.action === 'created').length} created · {results.filter(r => r.action === 'synced').length} synced · {results.filter(r => r.action === 'created_stagnant').length} stagnant · {results.filter(r => !r.success).length} failed
              </p>
              {stats.remaining_after === 0 ? (
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
  {results.length === 0 
    ? 'All records already imported — nothing new to process.'
    : `All ${stats.total_in_jobber.toLocaleString()} Jobber records have been processed.`
  }
</p>
              ) : (
                <p style={{ fontSize: '12px', color: '#f59e0b', marginTop: '2px' }}>
                  {stats.remaining_after.toLocaleString()} records could not be completed. Check errors below.
                </p>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.75rem' }}>
            <span style={{ fontSize: '13px', color: '#22c55e' }}>✓ {results.filter(r => r.action === 'created').length} created</span>
            <span style={{ fontSize: '13px', color: '#3b82f6' }}>↻ {results.filter(r => r.action === 'synced').length} synced</span>
            <span style={{ fontSize: '13px', color: '#f59e0b' }}>~ {results.filter(r => r.action === 'created_stagnant').length} stagnant</span>
            <span style={{ fontSize: '13px', color: '#ef4444' }}>✗ {results.filter(r => !r.success).length} failed</span>
          </div>

          <div style={{ display: 'grid', gap: '3px', maxHeight: '250px', overflowY: 'auto' }}>
            {results.map((result, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 12px', background: 'var(--bg-elevated)', borderRadius: '4px' }}>
                <span style={{ fontSize: '12px' }}>{result.client}</span>
                <span style={{ fontSize: '11px', color: getActionColor(result.action), fontWeight: 500 }}>
                  {getActionLabel(result.action, result.reason)}
                  {result.stage ? ` — ${result.stage}` : ''}
                  {result.error ? ` — ${result.error}` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
