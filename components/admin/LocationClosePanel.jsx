// components/admin/LocationClosePanel.jsx
// ─────────────────────────────────────────────────────────────
// Close (or reopen) a location — Admin → a location's detail sheet, super_admin
// only. Rendered only for super_admin; the routes refuse everyone else on
// their own (app/api/admin/locations/[id]/close and ./reopen).
//
// THE DRY RUN IS THE EASY BUTTON. Nothing here writes until a person has seen
// the dry run's counts AND typed the location's name. The first button only
// asks "what would closing do?"; the server answers with every count it would
// write (lib/location-close planLocationClose).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { T } from '@/components/hive/shared/tokens'
import { SECTION_LABEL } from '@/components/ui/tokens'
import { zipStyles } from './zips/zipParts'

const { card, input, btn, muted } = zipStyles
const dangerBtn = { ...btn, background: T.state.danger.fg, color: '#fff', border: 'none', fontWeight: 600 }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const n = (x) => (typeof x === 'number' ? x.toLocaleString() : '0')

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, body: j }
}

function CloseCounts({ plan }) {
  const c = plan.counts
  const moved = Object.entries(c.moved || {}).filter(([, v]) => v > 0)
  return (
    <div data-testid="close-plan" style={{ fontSize: '12.5px', color: T.ink.primary, display: 'grid', gap: '3px', marginTop: '8px' }}>
      <div>Zips released to Other: <b>{n(c.zips_released)}</b></div>
      <div>Clients moved to Other: <b>{n(c.moved?.leads)}</b> ({n(plan.facts.leads_joining_other_queue)} still open — they join Leslie’s “Not yet routed” list)</div>
      {moved.filter(([t]) => t !== 'leads').length > 0 && (
        <div style={muted}>Also moved: {moved.filter(([t]) => t !== 'leads').map(([t, v]) => `${t} ${n(v)}`).join(' · ')}</div>
      )}
      <div>Automatic emails stopped: <b>{n(c.drips_stopped)}</b> drips, <b>{n(c.stage_emails_cancelled)}</b> scheduled</div>
      <div>People switched off: <b>{n(c.users_disabled)}</b> (none deleted) · invites expired: {n(c.invites_expired)}</div>
      <div>Seats ended: <b>{n(c.seats_ended)}</b> of {n(plan.facts.seats_kept_total)} (all kept) · billing records kept: {n(plan.facts.billing_invoices_kept)}</div>
      <div>Stripe subscription: {plan.facts.stripe_subscription_id ? `${plan.facts.stripe_subscription_id} — cancelled now, no refund` : 'none'}</div>
      <div>Jobber + Slack: disconnected</div>
    </div>
  )
}

export default function LocationClosePanel({ locationId, role }) {
  const [plan, setPlan] = useState(null)
  const [reopenPlan, setReopenPlan] = useState(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)

  if (role !== 'super_admin' || !locationId || !UUID_RE.test(locationId)) return null
  const base = `/api/admin/locations/${encodeURIComponent(locationId)}`

  const run = async (path, body, onOk) => {
    setBusy(true); setError(null); setMessage(null)
    try {
      const r = await post(path, body)
      if (!r.ok) setError(r.body?.detail || r.body?.error || `failed (${r.status})`)
      onOk(r.body)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const dryRun = () => run(`${base}/close`, { mode: 'dry_run' }, (b) => { setPlan(b.plan || null); setTyped('') })
  const reopenDryRun = () => run(`${base}/reopen`, { mode: 'dry_run' }, (b) => { setReopenPlan(b.plan || null); setTyped('') })
  const close = () => run(`${base}/close`, { mode: 'close', confirm_name: typed }, (b) => {
    if (b.done) {
      setMessage(`Closed. ${n(b.done.moved?.leads)} clients moved to Other, ${n(b.done.zips_released)} zips released.` +
        (b.warnings?.length ? ` Needs a look: ${b.warnings.join('; ')}` : ''))
      setPlan(null)
    } else if (b.plan) setPlan(b.plan)
  })
  const reopen = () => run(`${base}/reopen`, { mode: 'reopen', confirm_name: typed }, (b) => {
    if (b.mode === 'reopen' && typeof b.users_reenabled === 'number') {
      setMessage(`Reopened. ${n(b.users_reenabled)} people switched back on. Clients stay in Other; zips, Jobber, Slack and billing are not restored.`)
      setReopenPlan(null)
    }
  })

  const name = plan?.location?.name || reopenPlan?.location?.name || ''
  const typedOk = name && typed.trim().toLowerCase() === name.trim().toLowerCase()

  return (
    <div data-testid="location-close" style={card}>
      <div style={SECTION_LABEL}>Close this location</div>
      <div style={{ ...muted, marginTop: '4px' }}>
        For a franchise that has shut down. Its clients go to Other, its zips are released, its people are switched off. Nothing is deleted.
      </div>

      {!plan && !reopenPlan && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
          <button style={btn} disabled={busy} onClick={dryRun}>{busy ? 'Checking…' : 'See what closing would do'}</button>
          <button style={btn} disabled={busy} onClick={reopenDryRun}>Reopen…</button>
        </div>
      )}

      {plan && (
        <div style={{ marginTop: '10px' }}>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>
            {plan.already_closed ? `${plan.location.name} is closed. Running it again finishes anything left:` : `Closing ${plan.location.name} would:`}
          </div>
          <CloseCounts plan={plan} />
          {plan.blockers.length > 0 ? (
            <div role="alert" style={{ color: T.state.danger.fg, fontSize: '12.5px', marginTop: '8px' }}>
              Can’t close yet: {plan.blockers.join(' ')}
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                style={{ ...input, flex: '1 1 180px' }}
                placeholder={`Type “${plan.location.name}” to confirm`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
              <button style={dangerBtn} disabled={busy || !typedOk} onClick={close}>{busy ? 'Closing…' : 'Close location'}</button>
            </div>
          )}
          <button style={{ ...btn, marginTop: '8px' }} disabled={busy} onClick={() => setPlan(null)}>Cancel</button>
        </div>
      )}

      {reopenPlan && (
        <div style={{ marginTop: '10px', fontSize: '12.5px' }}>
          <div>Reopening {reopenPlan.location.name} would set it back to <b>{reopenPlan.restore_status}</b> and switch <b>{n(reopenPlan.users_reenabled)}</b> people back on.</div>
          <div style={muted}>It would not bring clients back from Other, re-add its {n(reopenPlan.released_zips.length)} zips, reconnect Jobber or Slack, or restart billing.</div>
          {reopenPlan.blockers.length > 0 ? (
            <div role="alert" style={{ color: T.state.danger.fg, marginTop: '8px' }}>{reopenPlan.blockers.join(' ')}</div>
          ) : (
            <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
              <input
                style={{ ...input, flex: '1 1 180px' }}
                placeholder={`Type “${reopenPlan.location.name}” to confirm`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
              <button style={btn} disabled={busy || !typedOk} onClick={reopen}>Reopen location</button>
            </div>
          )}
          <button style={{ ...btn, marginTop: '8px' }} disabled={busy} onClick={() => setReopenPlan(null)}>Cancel</button>
        </div>
      )}

      {message && <div role="status" style={{ marginTop: '8px', fontSize: '12.5px', color: T.ink.primary }}>{message}</div>}
      {error && <div role="alert" style={{ marginTop: '8px', fontSize: '12.5px', color: T.state.danger.fg }}>{error}</div>}
    </div>
  )
}
