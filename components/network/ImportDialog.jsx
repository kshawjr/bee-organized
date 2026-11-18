'use client'

// IMPORT CONTACTS FROM A CSV FILE (Network & Nurture redesign, slice 5).
//
// The Lovable design's ImportDialog (brief-and-current, ImportDialog.tsx),
// with its Excel branch taken out: CSV only, no package (the xlsx package
// has two high advisories). A spreadsheet saved as .xlsx is answered with how
// to save it as CSV.
//
// Where Bee Hub differs from the design, on purpose:
//   · THE SERVER CHECKS THE FILE FIRST (POST /api/network/import, mode
//     'check'), against this location's real contacts and tags, and writes
//     nothing. The box shows exactly what Add would do: who comes in, who is
//     skipped because they are already here (and who it matched, and by
//     which rule: the email, or with no email the same name and phone, or
//     the same name with no phone on either side), and every tag word that
//     matched nothing.
//   · A ROW THAT CANNOT BE READ IS SKIPPED AND NAMED, by line and reason,
//     and the rest of the file comes in (as the design did, and as a
//     duplicate is skipped). Every skipped row is listed on screen, none
//     cut off. Saving is still all or nothing: the rows that come in either
//     all save or none do.
//   · Add sends the same file again (mode 'import'). The server plans it
//     again against the data as it is NOW and answers what it actually did.
//
// LOCATION: the one the list is looking at, named in the box. The list only
// offers Import inside one location.
//
// Fonts: it is only ever drawn inside the Network list, which asks for
// them itself, so this file makes no font request of its own.
//
// It closes by its own ✕, Cancel, Done or Escape, never by a tap outside.

import React, { useEffect, useRef, useState } from 'react'
import { T, NET } from '@/components/design/tokens'
import { IMPORT_COLUMNS, SAMPLE_CSV } from '@/lib/network/csv'
import { IMPORT_MAX_CHARS, IMPORT_REFUSAL_WORDS } from '@/lib/network/contact-create'
import { downloadText } from '@/lib/network/csv-download'
import { SHEET_CSS } from './ContactSheet'

const S = '[data-network-import]'
const CSS = `
[data-network-sheet]${S}{justify-content:center;align-items:center;padding:16px}
${S} .ni{display:flex;flex-direction:column;width:100%;max-width:672px;max-height:min(760px,calc(100dvh - 32px));border:1px solid ${T.border};border-radius:16px;overflow:hidden;background:${T.background};box-shadow:0 24px 60px -20px rgba(26,48,44,.35);outline:none}
${S} .ni-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px;border-bottom:1px solid ${T.border};background:${T.card}}
${S} .ni-head h2{margin:2px 0 0;font-family:inherit;font-size:17px!important;font-weight:700;color:${T.primary}}
${S} .ni-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior-y:contain;display:grid;align-content:start;gap:16px;padding:18px 20px}
${S} .ni-foot{display:flex;flex-shrink:0;align-items:center;justify-content:flex-end;gap:8px;padding:12px 20px calc(12px + env(safe-area-inset-bottom,0px));border-top:1px solid ${T.border};background:${T.card}}
${S} .ni-steps{display:grid;gap:10px;margin:0;padding:0;list-style:none;counter-reset:ni}
${S} .ni-steps li{display:grid;grid-template-columns:28px 1fr;gap:2px 10px;counter-increment:ni;font-size:14px;color:${T.primary}}
${S} .ni-steps li::before{content:counter(ni);grid-row:span 2;display:grid;place-items:center;width:28px;height:28px;border-radius:999px;background:${T.goldSoft};color:${NET.accentFg};font-weight:700;font-size:13px}
${S} .ni-steps span{font-size:12.5px;color:${T.mutedFg}}
${S} .ni-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-height:132px;padding:16px!important;border:2px dashed ${T.input}!important;border-radius:14px;background:${T.card};color:${T.primary};text-align:center!important}
${S} .ni-drop[data-drag]{border-color:${T.primary}!important;background:${T.sageSoft}}
${S} .ni-drop b{font-size:15px}
${S} .ni-drop small{font-size:12px;color:${T.mutedFg}}
${S} .ni-sample{justify-self:start;display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 14px!important;border:1px solid ${T.input}!important;border-radius:10px;background:${T.card};color:${T.primary};font-size:13.5px!important;font-weight:600}
${S} details{border:1px solid ${T.border};border-radius:12px;background:${T.card};padding:0 14px}
${S} summary{min-height:44px;display:flex;align-items:center;cursor:pointer;font-size:13.5px;font-weight:700;color:${T.primary}}
${S} dl{display:grid;gap:8px;margin:0 0 14px;font-size:13px}
${S} dt{font-weight:700;color:${T.primary}}
${S} dt em{font-style:normal;font-weight:400;color:${NET.accentFg};margin-left:6px}
${S} dd{margin:0;color:${T.mutedFg}}
${S} .ni-file{display:flex;align-items:center;gap:12px;padding:12px;border:1px solid ${T.border};border-radius:12px;background:${T.card}}
${S} .ni-file div{flex:1;min-width:0}
${S} .ni-file b{display:block;font-size:14px;color:${T.primary};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
${S} .ni-file small{font-size:12.5px;color:${T.mutedFg}}
${S} .ni-box{padding:12px 14px;border-radius:12px;font-size:13.5px;line-height:1.45;color:${T.primary}}
${S} .ni-box h3{margin:0 0 6px;font-family:inherit;font-size:13.5px!important;font-weight:700;color:${T.primary}}
${S} .ni-box ul{margin:0;padding-left:18px;display:grid;gap:3px}
${S} .ni-box p{margin:0}
${S} .ni-box[data-tone="bad"]{background:color-mix(in oklab,${T.destructive} 9%,${T.card});border:1px solid color-mix(in oklab,${T.destructive} 35%,transparent)}
${S} .ni-box[data-tone="warn"]{background:${NET.warnSoft};border:1px solid ${NET.warn}}
${S} .ni-box[data-tone="good"]{background:${T.sageSoft};border:1px solid color-mix(in oklab,${T.primary} 25%,transparent)}
${S} .ni-box[data-tone="note"]{background:${T.card};border:1px solid ${T.border}}
${S} .ni-words{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
${S} .ni-words span{padding:1px 8px;border-radius:999px;border:1px solid ${T.input};background:${T.card};font-size:12.5px}
${S} .ni-list{margin:0;padding:0;list-style:none;border:1px solid ${T.border};border-radius:12px;background:${T.card}}
${S} .ni-list li{display:grid;gap:2px;padding:9px 14px;border-bottom:1px solid ${T.border};font-size:14px;color:${T.primary};min-width:0}
${S} .ni-list li:last-child{border-bottom:0}
${S} .ni-list span{font-size:12.5px;color:${T.mutedFg};overflow-wrap:anywhere}
${S} .ni-line{font-variant-numeric:tabular-nums;color:${T.mutedFg};margin-right:6px}
@media (max-width:600px){
  [data-network-sheet]${S}{padding:0;align-items:flex-end}
  ${S} .ni{max-height:calc(100dvh - 12px);border-radius:16px 16px 0 0}
}
`

const IconX = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
const IconUp = () => <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /></svg>
const IconDown = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /></svg>

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const NOT_SENT = 'We couldn’t reach Bee Hub to check that file. Nothing was added. Check the connection and choose the file again.'
const SPREADSHEET = /\.(xlsx|xlsm|xls|numbers|ods)$/i

/**
 * Props
 *   locationId, locationName   where the file goes (required)
 *   onClose()                  leave
 *   onImported(count)          after contacts came in, so the list reloads
 *   fetchImpl                  for tests
 */
export default function ImportDialog({ locationId, locationName = '', onClose, onImported = () => {}, fetchImpl = null }) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null)
  const input = useRef(null)
  const box = useRef(null)
  const [file, setFile] = useState(null) // { name, text }
  const [check, setCheck] = useState(null) // the server's answer to 'check'
  const [done, setDone] = useState(null) // the server's answer to 'import'
  const [refusal, setRefusal] = useState('') // words: the file could not be used at all
  const [busy, setBusy] = useState('') // '' | 'checking' | 'adding'
  const [drag, setDrag] = useState(false)

  useEffect(() => {
    box.current?.focus({ preventScroll: true })
    const key = (e) => { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [busy, onClose])

  const send = async (mode, text) => {
    const res = await doFetch('/api/network/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: locationId, csv: text, mode }) })
    return { res, json: await res.json().catch(() => ({})) }
  }

  const reset = () => { setFile(null); setCheck(null); setDone(null); setRefusal('') }

  async function load(picked) {
    if (!picked || busy) return
    reset()
    if (SPREADSHEET.test(picked.name)) { setRefusal(IMPORT_REFUSAL_WORDS.not_csv); setFile({ name: picked.name, text: null }); return }
    if (picked.size > IMPORT_MAX_CHARS * 2) { setRefusal(IMPORT_REFUSAL_WORDS.too_big); setFile({ name: picked.name, text: null }); return }
    let text
    try { text = await picked.text() } catch { setRefusal('We couldn’t read that file. Save it as CSV and choose it again.'); return }
    setFile({ name: picked.name, text })
    setBusy('checking')
    try {
      const { res, json } = await send('check', text)
      if (res.ok && json.ok) setCheck(json)
      else setRefusal(IMPORT_REFUSAL_WORDS[json?.reason] || NOT_SENT)
    } catch {
      setRefusal(NOT_SENT)
    } finally {
      setBusy('')
    }
  }

  async function add() {
    if (!file?.text || !check?.ok || busy) return
    setBusy('adding')
    try {
      const { res, json } = await send('import', file.text)
      if (res.ok && json.ok) { setDone(json); if (json.added > 0) onImported(json.added) }
      else if (json?.reason === 'partly_saved') setRefusal('Something went wrong part way and not everything could be taken back out. Please tell Kevin before trying again, so nobody is added twice.')
      else setRefusal(json?.reason === 'not_saved' ? 'That import did not go in. Nothing was added. Try again in a minute.' : (IMPORT_REFUSAL_WORDS[json?.reason] || NOT_SENT))
    } catch {
      setRefusal('We couldn’t tell whether that import went in. Close this box and look at the list before trying again.')
    } finally {
      setBusy('')
    }
  }

  const adding = check?.ok ? check.adding.length : 0
  const summary = done || check
  const unreadable = summary?.ok && Array.isArray(summary.unreadable) ? summary.unreadable : []

  return (
    <div data-network-sheet data-network-import role="presentation">
      <style>{SHEET_CSS + CSS}</style>
      <div className="ni" role="dialog" aria-modal="true" aria-label="Import contacts" tabIndex={-1} ref={box}>
        <div className="ni-head">
          <div>
            <p className="ns-eyebrow">Import contacts · {locationName || 'this location'}</p>
            <h2>From a CSV file</h2>
          </div>
          <button type="button" className="ns-close" onClick={onClose} disabled={!!busy} aria-label="Close import" title="Close"><IconX /></button>
        </div>

        <div className="ni-body">
          {!file && (
            <>
              <ol className="ni-steps" data-import-steps>
                <li><b>Download the sample</b><span>It has the right column names and four example rows.</span></li>
                <li><b>Fill in your contacts</b><span>One person or organization per row. Only Name is required.</span></li>
                <li><b>Save it as CSV and choose it here</b><span>Excel and Google Sheets both save as CSV. You’ll see what will happen before anything is added.</span></li>
              </ol>
              <button type="button" className="ni-sample" onClick={() => downloadText('bee-hub-contacts-sample.csv', '﻿' + SAMPLE_CSV + '\n')} data-sample><IconDown />Download sample file</button>
              <button type="button" className="ni-drop" data-drag={drag || undefined} onClick={() => input.current?.click()} data-choose
                onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); load(e.dataTransfer.files?.[0]) }}>
                <IconUp /><b>Choose a file or drop it here</b><small>.csv only</small>
              </button>
              <details data-guide>
                <summary>Column guide</summary>
                <dl>{IMPORT_COLUMNS.map((c) => <div key={c.key}><dt>{c.key}{c.required && <em>required</em>}</dt><dd>{c.help}</dd></div>)}</dl>
              </details>
            </>
          )}
          <input ref={input} type="file" hidden accept=".csv,text/csv" onChange={(e) => { load(e.target.files?.[0]); e.target.value = '' }} data-file-input />

          {file && (
            <div className="ni-file" data-file>
              <div><b>{file.name}</b>
                <small>{busy === 'checking' ? 'Checking it against the contacts already here…'
                  : done ? `${plural(done.added, 'contact')} added to ${done.location?.name || locationName}`
                  : check?.ok ? `${plural(adding, 'contact')} ready to add${check.skipped.length ? ` · ${check.skipped.length} already here` : ''}${unreadable.length ? ` · ${unreadable.length} can’t be read` : ''}`
                  : refusal ? 'This file can’t be used' : ''}</small>
              </div>
              {!done && !busy && <button type="button" className="ns-btn ns-btn-ghost" onClick={() => { reset(); setTimeout(() => input.current?.click(), 0) }} data-another>Choose another</button>}
            </div>
          )}

          {refusal && <div className="ni-box" data-tone="bad" role="alert" data-refusal><p>{refusal}</p></div>}

          {done && (
            <div className="ni-box" data-tone="good" role="status" data-done>
              <h3>{done.added ? `${plural(done.added, 'contact')} added to ${done.location?.name || locationName}.` : 'Nobody new was added.'}</h3>
              <p>{done.added ? 'They are on the list now. Open one to finish their details.' : unreadable.length ? 'Every row was either already here or couldn’t be read.' : 'Everyone in the file is already here.'}</p>
            </div>
          )}

          {unreadable.length > 0 && (
            <div className="ni-box" data-tone="bad" data-unreadable>
              <h3>{plural(unreadable.length, 'row')} {done ? (unreadable.length === 1 ? 'was' : 'were') : 'will be'} skipped: {unreadable.length === 1 ? 'it' : 'they'} couldn’t be read</h3>
              <p style={{ marginBottom: 6 }}>{done ? 'Everyone else came in.' : 'Everyone else still comes in.'} To bring {unreadable.length === 1 ? 'this one' : 'these'} in too, fix {unreadable.length === 1 ? 'it' : 'them'} in your file and import the whole file again: everyone already here is skipped.</p>
              <ul>{unreadable.map((p) => <li key={p.line} data-unreadable-line={p.line}><span className="ni-line">Row {p.line}</span>{p.name ? <b>{p.name}: </b> : null}{p.problems.join('; ')}</li>)}</ul>
            </div>
          )}

          {summary?.ok && summary.skipped.length > 0 && (
            <div className="ni-box" data-tone="warn" data-skipped>
              <h3>{plural(summary.skipped.length, 'row')} {done ? (summary.skipped.length === 1 ? 'was' : 'were') : 'will be'} skipped: they’re already here</h3>
              <p style={{ marginBottom: 6 }}>{done ? 'Nobody was changed.' : 'Nobody here will be changed.'} To update someone, open them on the list and edit them there.</p>
              <ul>{summary.skipped.map((s) => <li key={s.line}><span className="ni-line">Row {s.line}</span><b>{s.name}</b>{s.email ? <> ({s.email})</> : null} {s.rule === 'name_phone' ? 'has no email, and the same name and phone as' : s.rule === 'name_only' ? 'has no email, and the same name as' : 'matches'} {s.matched.id ? <b data-matched={s.matched.id}>{s.matched.name}</b> : <>row {s.matched.line} of this file, <b>{s.matched.name}</b></>}{s.rule === 'name_only' ? ', with no phone on either' : ''}</li>)}</ul>
            </div>
          )}

          {summary?.ok && summary.unmatchedTags.length > 0 && (
            <div className="ni-box" data-tone="note" data-unmatched>
              <h3>{summary.unmatchedTags.length === 1 ? 'One tag word' : `${summary.unmatchedTags.length} tag words`} didn’t match a tag here, so {summary.unmatchedTags.length === 1 ? 'it was' : 'they were'} left off</h3>
              <p>The contacts {done ? 'still came in' : 'still come in'}. A file never makes new tags: add {summary.unmatchedTags.length === 1 ? 'it' : 'them'} from a contact’s tag box, then run the file again{done ? '' : ' if you want them on'}.</p>
              <div className="ni-words">{summary.unmatchedTags.map((w) => <span key={w} data-word>{w}</span>)}</div>
            </div>
          )}

          {summary?.ok && summary.warnings.length > 0 && (
            <details data-warnings>
              <summary>{plural(summary.warnings.length, 'note')} about rows that {done ? 'came' : 'come'} in</summary>
              <ul className="ni-list" style={{ marginBottom: 14 }}>{summary.warnings.map((w, i) => <li key={i}><span><span className="ni-line">Row {w.line}</span>{w.name}</span>{w.words}</li>)}</ul>
            </details>
          )}

          {check?.ok && !done && adding > 0 && (
            <ul className="ni-list" data-preview>
              {check.adding.slice(0, 50).map((r) => <li key={r.line}><b>{r.name}</b><span>{[r.company, r.phone, r.email].filter(Boolean).join(' · ') || 'No details yet'}{r.tags ? ` · ${plural(r.tags, 'tag')}` : ''}</span></li>)}
              {check.adding.length > 50 && <li><span>…and {check.adding.length - 50} more</span></li>}
            </ul>
          )}
        </div>

        <div className="ni-foot">
          {done ? (
            <button type="button" className="ns-btn ns-btn-primary" onClick={onClose} data-close>Done</button>
          ) : (
            <>
              <button type="button" className="ns-btn ns-btn-ghost" onClick={onClose} disabled={!!busy} data-cancel>Cancel</button>
              <button type="button" className="ns-btn ns-btn-primary" onClick={add} disabled={!!busy || !check?.ok || adding === 0} data-add>
                {busy === 'adding' ? 'Adding…' : adding ? `Add ${plural(adding, 'contact')}` : 'Add contacts'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
