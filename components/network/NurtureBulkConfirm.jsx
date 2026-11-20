// components/network/NurtureBulkConfirm.jsx
// ─────────────────────────────────────────────────────────────
// THE ONE QUESTION before a bulk tag on Nurturing people (slice 8).
//
//   1. COUNTING. It asks the server what the selection really means
//      (POST /api/network/nurturing/bulk with dry_run: a read, nothing
//      written).
//   2. ASKING. One question for the whole selection, and it names the exact
//      number: "Add “Garage” to 18,816 people?". Under it, who is left out
//      and why (said no to marketing, already have it, no longer Nurturing).
//      Cancel closes it and sends nothing more.
//   3. RUNNING. The yes sends the same request with confirmed + expected. The
//      server refuses if the number changed in the meantime.
//   4. DONE, or NOT DONE. A failure says in plain words what state it left:
//      nothing changed (the usual: what was done is put back), or exactly how
//      many are left changed.
//
// A WINDOW: it closes only by its own buttons (never by a click outside),
// and not at all while the change is running.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useRef, useState } from 'react'
import { T, NET, FONT } from '@/components/design/tokens'

const CSS = `
[data-nurture-bulk]{position:fixed;inset:0;z-index:500;display:flex;align-items:center;justify-content:center;padding:16px;background:color-mix(in oklab,${T.primary} 35%,transparent);font-family:${FONT.ui};color:${T.foreground}}
[data-nurture-bulk] *{box-sizing:border-box}
[data-nurture-bulk] .nb{width:min(480px,100%);max-height:calc(100dvh - 32px);overflow-y:auto;background:${T.card};border:1px solid ${T.border};border-radius:16px;padding:20px;box-shadow:0 24px 60px -20px rgba(26,48,44,.45)}
[data-nurture-bulk] h2{font-family:${FONT.heading};font-size:20px;font-weight:600;line-height:1.3;color:${T.primary};margin:0;overflow-wrap:anywhere}
[data-nurture-bulk] p{margin:10px 0 0;font-size:14px;line-height:1.5}
[data-nurture-bulk] .nb-quiet{color:${T.mutedFg};font-size:13px}
[data-nurture-bulk] ul{margin:10px 0 0;padding-left:18px;font-size:13px;color:${T.mutedFg}}
[data-nurture-bulk] .nb-warn{padding:10px 12px;border-radius:10px;background:${NET.warnSoft};border:1px solid ${NET.warn};color:${T.foreground}}
[data-nurture-bulk] .nb-good{padding:10px 12px;border-radius:10px;background:${T.sageSoft};color:${T.primary};font-weight:700}
[data-nurture-bulk] .nb-foot{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:18px}
[data-nurture-bulk] button{font-family:inherit;min-height:44px;padding:0 16px;border-radius:10px;border:1px solid ${T.input};background:${T.card};color:${T.primary};font-size:14px;font-weight:700;cursor:pointer}
[data-nurture-bulk] button[data-primary]{background:${T.primary};border-color:${T.primary};color:${T.primaryFg}}
[data-nurture-bulk] button:disabled{opacity:.5;cursor:not-allowed}
[data-nurture-bulk] .nb-bar{position:relative;height:6px;margin-top:14px;border-radius:999px;background:${T.muted};overflow:hidden}
[data-nurture-bulk] .nb-bar i{position:absolute;inset:0 auto 0 0;width:40%;border-radius:999px;background:${T.primary};animation:nb-run 1.2s ease-in-out infinite}
@keyframes nb-run{from{left:-40%}to{left:100%}}
@media (prefers-reduced-motion:reduce){[data-nurture-bulk] .nb-bar i{animation:none;width:100%}}
`

const n = (x) => Number(x || 0).toLocaleString('en-US')
const people = (k) => `${n(k)} ${k === 1 ? 'person' : 'people'}`

/**
 * props:
 *   request    { location_id, action, tag_id, selection } — what to ask about
 *   onClose    (changed: boolean) => void
 *   fetchImpl  tests
 */
export default function NurtureBulkConfirm({ request, onClose, fetchImpl = null }) {
  const [phase, setPhase] = useState('counting') // counting | ask | running | done | failed | changed | problem
  const [answer, setAnswer] = useState(null)
  const [result, setResult] = useState(null)
  const yes = useRef(null)
  const post = async (extra) => {
    const res = await (fetchImpl || fetch)('/api/network/nurturing/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, ...extra }),
    })
    return { res, json: await res.json().catch(() => ({})) }
  }

  const count = async () => {
    setPhase('counting'); setResult(null)
    try {
      const { res, json } = await post({ dry_run: true })
      if (!res.ok) { setResult({ words: `We couldn’t count them (${json?.error || res.status}). Nothing was changed.` }); setPhase('problem'); return }
      setAnswer(json); setPhase('ask')
    } catch { setResult({ words: 'No connection, so nothing was counted or changed.' }); setPhase('problem') }
  }
  useEffect(() => { count() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (phase === 'ask') yes.current?.focus({ preventScroll: true }) }, [phase])

  const go = async () => {
    setPhase('running')
    try {
      const { res, json } = await post({ confirmed: true, expected: answer.change })
      if (res.status === 409 && json?.error === 'count_changed') { setAnswer(json); setPhase('changed'); return }
      if (!res.ok || !json?.ok) {
        setResult({ words: json?.words || `That didn’t finish (${json?.error || res.status}). ${json?.state === 'nothing_changed' ? 'Nothing was changed.' : 'Run the same action again to finish it.'}`, state: json?.state || null, left: json?.leftChanged?.length || 0 })
        setPhase('failed'); return
      }
      setResult(json); setPhase('done')
    } catch {
      // The request may or may not have reached the server: say so, never guess.
      setResult({ words: 'The connection dropped before Bee Hub answered, so we can’t tell whether it finished. Run the same action again: anyone already done is left as they are.' })
      setPhase('failed')
    }
  }

  // Escape is Cancel while asking; never while running.
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape' && phase !== 'running') { e.stopPropagation(); onClose(phase === 'done') } }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [phase, onClose])

  const adding = request.action === 'tag_add'
  const label = answer?.tag?.label || ''
  return (
    <div data-nurture-bulk role="presentation" data-phase={phase}>
      <style>{CSS}</style>
      <section className="nb" role="alertdialog" aria-modal="true" aria-label={answer?.question || 'Bulk change'}>
        {phase === 'counting' && (<>
          <h2>Counting who this changes…</h2>
          <p className="nb-quiet">Nothing has been changed.</p>
          <div className="nb-bar"><i /></div>
          <div className="nb-foot"><button type="button" onClick={() => onClose(false)} data-bulk-cancel>Cancel</button></div>
        </>)}

        {(phase === 'ask' || phase === 'changed') && answer && (<>
          {phase === 'changed' && <p className="nb-warn" style={{ marginTop: 0, marginBottom: 12 }} data-bulk-changed>The list changed while you were deciding, so nothing was changed. Here is the new number.</p>}
          <h2 data-bulk-question>{answer.change ? answer.question : `Nobody to ${adding ? 'add it to' : 'take it off'}.`}</h2>
          {answer.change > 0 && answer.names?.length > 0 && (
            <ul data-bulk-names>{answer.names.map((x, i) => <li key={i}>{x}</li>)}{answer.change > answer.names.length && <li data-bulk-more>and {n(answer.change - answer.names.length)} more</li>}</ul>
          )}
          {answer.leftOut?.map((w, i) => <p key={i} className="nb-quiet" data-bulk-left-out>{w}</p>)}
          {answer.change > 0 && <p className="nb-quiet" data-bulk-undo>A tag sends no email. You can take it off again the same way.</p>}
          <div className="nb-foot">
            <button type="button" onClick={() => onClose(false)} data-bulk-cancel>Cancel</button>
            {answer.change > 0 && <button type="button" ref={yes} data-primary onClick={go} data-bulk-yes>{adding ? `Yes, add to ${people(answer.change)}` : `Yes, take off ${people(answer.change)}`}</button>}
          </div>
        </>)}

        {phase === 'running' && answer && (<>
          <h2 data-bulk-running>{adding ? `Adding “${label}” to ${people(answer.change)}…` : `Taking “${label}” off ${people(answer.change)}…`}</h2>
          <p className="nb-quiet">This can take up to a minute for a big list. Keep this page open. If it can’t finish, everything it did is put back.</p>
          <div className="nb-bar"><i /></div>
        </>)}

        {phase === 'done' && result && (<>
          <p className="nb-good" style={{ marginTop: 0 }} role="status" data-bulk-done>{adding ? `Added “${label}” to ${people(result.changed)}.` : `Took “${label}” off ${people(result.changed)}.`}</p>
          <div className="nb-foot"><button type="button" data-primary onClick={() => onClose(true)} data-bulk-close>Done</button></div>
        </>)}

        {(phase === 'failed' || phase === 'problem') && result && (<>
          {/* The heading says the STATE; the box under it says what happened and what to do. */}
          <h2 data-bulk-failed-title>{phase === 'problem' ? 'We couldn’t count them' : result.state === 'nothing_changed' ? 'Nothing was changed' : result.state === 'partly_changed' ? 'Only partly done' : 'We can’t tell if it finished'}</h2>
          <p className="nb-warn" role="alert" data-bulk-failed data-state={result.state || undefined}>{result.words}</p>
          <div className="nb-foot">
            <button type="button" onClick={() => onClose(result.state === 'partly_changed')} data-bulk-close>Close</button>
            <button type="button" data-primary onClick={count} data-bulk-again>Try again</button>
          </div>
        </>)}
      </section>
    </div>
  )
}
