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
// A FILE THAT ISN'T OURS (third follow-up, 2026-11-19). After a file is
// chosen, the box shows THEIR columns on the left and Bee Hub's fields on the
// right, each already guessed from the column's heading (or recalled, if a
// file with the same headings was imported here before). The owner corrects
// any guess from a dropdown or marks a column Ignore, and sees the first 3
// rows EXACTLY AS THEY WOULD LAND (planned by the same rules the server
// uses), not the raw file. Then the file is rewritten into Bee Hub's own
// headings (lib/network/import-mapping.ts) and the check above runs as it
// always has. Columns with nothing in them are left out of the list and
// ignored. Several phone or email columns: Bee Hub keeps one of each; the
// guess takes the fullest, the others are named, and a field moves when it
// is given to another column. No Phone column at all: nobody gets a phone,
// and the box says so.
//
// LOCATION: the one the list is looking at, named in the box. The list only
// offers Import inside one location.
//
// Fonts: it is only ever drawn inside the Network list, which asks for
// them itself, so this file makes no font request of its own.
//
// It closes by its own ✕, Cancel, Done or Escape, never by a tap outside.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { T, NET } from '@/components/design/tokens'
import { IMPORT_COLUMNS, SAMPLE_CSV } from '@/lib/network/csv'
import { IMPORT_MAX_CHARS, IMPORT_REFUSAL_WORDS, looksBinary, planImport } from '@/lib/network/contact-create'
import { FIELDS, MANY_OF, alsoLooksLike, applyMapping, guessMapping, mappingProblems, readShape, recallMapping, setColumn } from '@/lib/network/import-mapping'
import { TYPE_META } from '@/lib/network/types'
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
${S} .ni-map{display:grid;gap:0;margin:0;padding:0;list-style:none;border:1px solid ${T.border};border-radius:12px;background:${T.card}}
${S} .ni-map-head,${S} .ni-map li{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:4px 12px;align-items:center;padding:9px 14px;border-bottom:1px solid ${T.border}}
${S} .ni-map li:last-child{border-bottom:0}
${S} .ni-map-head{font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${T.mutedFg}}
${S} .ni-col{min-width:0}
${S} .ni-col b{display:block;font-size:14px;color:${T.primary};overflow-wrap:anywhere}
${S} .ni-col small{display:block;font-size:12px;color:${T.mutedFg};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
${S} .ni-map select{width:100%;min-height:44px}
${S} .ni-map li[data-ignored] b{color:${T.mutedFg};font-weight:400}
${S} .ni-also{grid-column:1/-1;margin:0;font-size:12px;color:${NET.accentFg}}
${S} .ni-land{display:grid;gap:8px;margin:0;padding:0;list-style:none}
${S} .ni-land li{display:grid;gap:3px;padding:10px 14px;border:1px solid ${T.border};border-radius:12px;background:${T.card};font-size:13px;color:${T.primary};min-width:0}
${S} .ni-land li b{font-size:14.5px}
${S} .ni-land dl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:2px 0 0;font-size:12.5px}
${S} .ni-land dt{font-weight:400;color:${T.mutedFg}}
${S} .ni-land dd{margin:0;overflow-wrap:anywhere}
${S} .ni-land li[data-kind="unreadable"]{border-color:color-mix(in oklab,${T.destructive} 35%,transparent)}
${S} .ni-sub{margin:0;font-size:13px;font-weight:700;color:${T.primary}}
@media (max-width:600px){
  ${S} .ni-map li.ni-map-head{display:none}
  ${S} .ni-map li{grid-template-columns:1fr}
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
  const [shape, setShape] = useState(null) // the owner's columns (lib/network/import-mapping readShape)
  const [mapping, setMapping] = useState(null) // one Bee Hub field (or null = Ignore) per column
  const [recalled, setRecalled] = useState(false) // the mapping came from an earlier file here
  const [saved, setSaved] = useState(null) // this location's remembered mappings, once loaded
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

  // The location's remembered mappings. Not having them never stops an import.
  useEffect(() => {
    let alive = true
    Promise.resolve(doFetch(`/api/network/import?location_id=${encodeURIComponent(locationId)}`))
      .then(async (res) => { const json = await res.json().catch(() => ({})); if (alive) setSaved(res.ok && json?.mappings && typeof json.mappings === 'object' ? json.mappings : {}) })
      .catch(() => { if (alive) setSaved({}) })
    return () => { alive = false }
  }, [locationId]) // eslint-disable-line react-hooks/exhaustive-deps

  // A file chosen before the remembered mappings arrived gets them when they do.
  useEffect(() => {
    if (!shape || !saved || recalled || check) return
    const r = recallMapping(saved, shape.headers)
    if (r) { setMapping(r); setRecalled(true) }
  }, [saved]) // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (mode, text, extra = {}) => {
    const res = await doFetch('/api/network/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: locationId, csv: text, mode, ...extra }) })
    return { res, json: await res.json().catch(() => ({})) }
  }

  const reset = () => { setFile(null); setShape(null); setMapping(null); setRecalled(false); setCheck(null); setDone(null); setRefusal('') }

  async function load(picked) {
    if (!picked || busy) return
    reset()
    if (SPREADSHEET.test(picked.name)) { setRefusal(IMPORT_REFUSAL_WORDS.not_csv); setFile({ name: picked.name, text: null }); return }
    if (picked.size > IMPORT_MAX_CHARS * 2) { setRefusal(IMPORT_REFUSAL_WORDS.too_big); setFile({ name: picked.name, text: null }); return }
    let text
    try { text = await picked.text() } catch { setRefusal('We couldn’t read that file. Save it as CSV and choose it again.'); return }
    setFile({ name: picked.name, text })
    if (looksBinary(text)) { setRefusal(IMPORT_REFUSAL_WORDS.not_csv); return }
    const sh = readShape(text)
    if (!sh || !sh.records.slice(sh.headerAt + 1).some((r) => r.length)) { setRefusal(IMPORT_REFUSAL_WORDS.no_rows); return }
    setShape(sh)
    const r = recallMapping(saved, sh.headers)
    setMapping(r || guessMapping(sh))
    setRecalled(!!r)
  }

  // The owner's file, in Bee Hub's own headings: what is checked and sent.
  const mapped = useMemo(() => (shape && mapping ? applyMapping(shape, mapping) : ''), [shape, mapping])
  const problems = mapping ? mappingProblems(mapping) : null
  // The first 3 rows exactly as they would land: the server's own planning
  // rules, run here on the rewritten file (who is already at the location,
  // and which tags match, is the check's job).
  const landing = useMemo(() => {
    if (!mapped || !problems || problems.noName) return null
    const p = planImport(mapped, { locationId, userId: null, tags: [], existing: [], now: new Date() })
    if (!p.ok) return null
    return [
      ...p.rows.map((r) => ({ kind: 'in', line: r.line, row: r.row })),
      ...p.unreadable.map((u) => ({ kind: 'unreadable', line: u.line, name: u.name, problems: u.problems })),
      ...p.skipped.map((k) => ({ kind: 'skipped', line: k.line, name: k.name, matched: k.matched })),
    ].sort((a, b) => a.line - b.line).slice(0, 3)
  }, [mapped]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (col, value) => { setMapping((m) => setColumn(m, col, value || null)); setCheck(null); setRefusal('') }

  async function runCheck() {
    if (!mapped || problems?.noName || busy) return
    setBusy('checking'); setRefusal('')
    try {
      const { res, json } = await send('check', mapped)
      if (res.ok && json.ok) setCheck(json)
      else setRefusal(IMPORT_REFUSAL_WORDS[json?.reason] || NOT_SENT)
    } catch {
      setRefusal(NOT_SENT)
    } finally {
      setBusy('')
    }
  }

  async function add() {
    if (!mapped || !check?.ok || busy) return
    setBusy('adding')
    try {
      const { res, json } = await send('import', mapped, { mapping: { headers: shape.headers, fields: mapping } })
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
  const mapping_open = !!(shape && mapping && !check && !done)
  const shown = shape ? shape.headers.map((h, i) => i).filter((i) => shape.filled[i] > 0) : []
  const empty = shape ? shape.headers.length - shown.length : 0
  const canPickMore = mapping ? shown.some((i) => mapping[i] === null) : false

  return (
    <div data-network-sheet data-network-import role="presentation">
      <style>{SHEET_CSS + CSS}</style>
      <div className="ni" role="dialog" aria-modal="true" aria-label="Import contacts" tabIndex={-1} ref={box}>
        <div className="ni-head">
          <div>
            <p className="ns-eyebrow">Import contacts · {locationName || 'this location'}</p>
            <h2>From a spreadsheet</h2>
          </div>
          <button type="button" className="ns-close" onClick={onClose} disabled={!!busy} aria-label="Close import" title="Close"><IconX /></button>
        </div>

        <div className="ni-body">
          {!file && (
            <>
              <ol className="ni-steps" data-import-steps>
                <li><b>Export your contacts as a CSV file</b><span>From Outlook, Google Contacts, Mailchimp, LinkedIn or any spreadsheet. Excel and Google Sheets both save as CSV.</span></li>
                <li><b>Choose it here</b><span>You’ll match your columns to Bee Hub’s. We guess first, and remember your choices for next time.</span></li>
                <li><b>Check, then add</b><span>You’ll see exactly what will happen before anything is added.</span></li>
              </ol>
              <button type="button" className="ni-drop" data-drag={drag || undefined} onClick={() => input.current?.click()} data-choose
                onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); load(e.dataTransfer.files?.[0]) }}>
                <IconUp /><b>Choose a file or drop it here</b><small>.csv only</small>
              </button>
              <button type="button" className="ni-sample" onClick={() => downloadText('bee-hub-contacts-sample.csv', '﻿' + SAMPLE_CSV + '\n')} data-sample><IconDown />Starting from nothing? Download a sample file</button>
              <details data-guide>
                <summary>Column guide</summary>
                <dl>
                  <div><dt>First name, Last name<em>or Name</em></dt><dd>A person’s name in two columns, or the whole name in one (we split it: first word, then the rest). An organization’s name is never split.</dd></div>
                  {IMPORT_COLUMNS.filter((c) => c.key !== 'Name').map((c) => <div key={c.key}><dt>{c.key}</dt><dd>{c.help}</dd></div>)}
                </dl>
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
                  : refusal ? 'This file can’t be used'
                  : shape ? `${plural(shape.headers.length, 'column')} · ${plural(shape.records.slice(shape.headerAt + 1).filter((r) => r.length).length, 'row')}` : ''}</small>
              </div>
              {!done && !busy && <button type="button" className="ns-btn ns-btn-ghost" onClick={() => { reset(); setTimeout(() => input.current?.click(), 0) }} data-another>Choose another</button>}
            </div>
          )}

          {mapping_open && (
            <>
              <div className="ni-box" data-tone="note" data-map-note={recalled ? 'recalled' : problems.nothingKnown ? 'nothing-known' : 'guessed'}>
                <p>{recalled ? 'Matched the way you did last time, for a file with these columns. Change anything that’s wrong.'
                  : problems.nothingKnown ? 'None of these column names are ones we know. Pick what each column holds, or leave it on Ignore.'
                  : 'We guessed from the column names. Check each one, and change any that’s wrong.'}</p>
              </div>
              <ul className="ni-map" data-mapping aria-label="Your columns and Bee Hub’s fields">
                <li className="ni-map-head" aria-hidden="true"><span>Your column</span><span>Goes into</span></li>
                {shown.map((i) => {
                  // A second phone or email column the owner might want instead.
                  const also = [...MANY_OF].find((k) => alsoLooksLike(shape, mapping, k).includes(i)) || null
                  return (
                    <li key={i} data-column={i} data-ignored={mapping[i] === null || undefined}>
                      <div className="ni-col"><b>{shape.headers[i] || `Column ${i + 1}`}</b><small>{shape.sample[i]}</small></div>
                      <select className="ns-input" value={mapping[i] || ''} onChange={(e) => pick(i, e.target.value)} aria-label={`What ${shape.headers[i] || `column ${i + 1}`} holds`} data-map-select={i}>
                        <option value="">Ignore</option>
                        {FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </select>
                      {also && mapping[i] === null && (
                        <p className="ni-also" data-also={also}>Another {also} column. Bee Hub keeps one {also} per contact{mapping.includes(also) ? `, from ${shape.headers[mapping.indexOf(also)]}` : ''}. Pick {also === 'phone' ? 'Phone' : 'Email'} here to use this one instead.</p>
                      )}
                    </li>
                  )
                })}
              </ul>
              {empty > 0 && <p className="na-where" data-empty-columns style={{ margin: 0, fontSize: 12.5, color: T.mutedFg }}>{plural(empty, 'column')} {empty === 1 ? 'has' : 'have'} nothing in {empty === 1 ? 'it' : 'them'} in this file, so {empty === 1 ? 'it is' : 'they are'} left out.</p>}
              {problems.noName ? (
                <div className="ni-box" data-tone="bad" role="alert" data-no-name><p>Pick the column that holds the name: <b>Name</b>, or <b>First name</b> and <b>Last name</b>.</p></div>
              ) : (
                <>
                  {canPickMore && (problems.noPhone || problems.noEmail) && (
                    <div className="ni-box" data-tone="warn" data-missing-fields>
                      <p>{problems.noPhone && problems.noEmail ? 'No column is set as Phone or Email, so these contacts come in with neither.' : problems.noPhone ? 'No column is set as Phone, so these contacts come in without a phone.' : 'No column is set as Email, so these contacts come in without an email.'}</p>
                    </div>
                  )}
                  {landing && (
                    <div data-landing>
                      <p className="ni-sub">The first {landing.length === 1 ? 'row' : `${landing.length} rows`}, as {landing.length === 1 ? 'it' : 'they'} would land</p>
                      <ul className="ni-land" style={{ marginTop: 8 }}>
                        {landing.map((x) => x.kind === 'in' ? (
                          <li key={x.line} data-kind="in" data-land-line={x.line}>
                            <b>{x.row.name}</b>
                            <dl>
                              {x.row.first_name || x.row.last_name ? <><dt>First / last</dt><dd>{x.row.first_name || '–'} / {x.row.last_name || '–'}</dd></> : null}
                              <dt>Type</dt><dd>{x.row.network_types.map((t) => TYPE_META[t]?.label || t).join(', ')}</dd>
                              {x.row.email ? <><dt>Email</dt><dd>{x.row.email}</dd></> : null}
                              {x.row.phone ? <><dt>Phone</dt><dd>{x.row.phone}</dd></> : null}
                              {x.row.company ? <><dt>Company</dt><dd>{x.row.company}</dd></> : null}
                              {x.row.title ? <><dt>Job title</dt><dd>{x.row.title}</dd></> : null}
                              {x.row.birthday ? <><dt>Birthday</dt><dd>{x.row.birthday}</dd></> : null}
                              {x.row.how_we_met ? <><dt>How met</dt><dd>{x.row.how_we_met}</dd></> : null}
                            </dl>
                          </li>
                        ) : x.kind === 'unreadable' ? (
                          <li key={x.line} data-kind="unreadable" data-land-line={x.line}><b>Row {x.line}{x.name ? `: ${x.name}` : ''}</b><span>Skipped: {x.problems.join('; ')}</span></li>
                        ) : (
                          <li key={x.line} data-kind="skipped" data-land-line={x.line}><b>Row {x.line}: {x.name}</b><span>Skipped: the same as row {x.matched.line} of this file</span></li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </>
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
              {check?.ok && <button type="button" className="ns-btn ns-btn-ghost" onClick={() => setCheck(null)} disabled={!!busy} data-change-columns>Change columns</button>}
              <button type="button" className="ns-btn ns-btn-ghost" onClick={onClose} disabled={!!busy} data-cancel>Cancel</button>
              {mapping_open || busy === 'checking' ? (
                <button type="button" className="ns-btn ns-btn-primary" onClick={runCheck} disabled={!!busy || !!problems?.noName} data-check>
                  {busy === 'checking' ? 'Checking…' : `Check against ${locationName || 'this location'}`}
                </button>
              ) : (
                <button type="button" className="ns-btn ns-btn-primary" onClick={add} disabled={!!busy || !check?.ok || adding === 0} data-add>
                  {busy === 'adding' ? 'Adding…' : adding ? `Add ${plural(adding, 'contact')}` : 'Add contacts'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
