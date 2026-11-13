// components/settings/CallScripts.jsx
// ─────────────────────────────────────────────────────────────
// Settings → Call scripts — slice 5 of the Settings rebuild (2026-11-13, the
// export's `Scripts` page in src/components/settings/pages.tsx).
//
// A list of scripts, one open at a time. A script is its title, when to use
// it, roughly how long it takes, and its stages in order. Nothing on this
// page is sent to anyone: a script is read aloud by the person on the call.
//
// WHERE THE WORDS COME FROM. `templates` rows of type 'call', as before:
//   · a row with no location is one of Bee Organized's own (a "master") —
//     every location sees it and nobody but corporate can change it;
//   · a row with a location is that location's own.
// The shape (when, minutes, stages) is held inside the row's `body` as plain
// text — lib/call-script.ts says how, and why not as new columns.
//
// {{BRACES}} ARE NOT MERGE TAGS. They are shown exactly as written, and the
// page says who fills them in: you, on the call. Nothing here hands a script
// to the merge-tag code, the preview-with-sample-values pop-up the old page
// used, or anything else that would swap them for a client's details.
//
// WHAT AN OWNER CAN DO is what they could do before: write a script of their
// own, edit it, delete it, and take a copy of one of Bee Organized's to make
// their own. The buttons differ from the export's in one place: it shows
// "Edit" and "Copy" on every script, but an owner cannot edit one of Bee
// Organized's, so on those the one button is "Make my own copy" and the
// copy is theirs to edit.
//
// This file decides nothing about WHO may open the page (that is
// `ownerConfig` in BeeHub.jsx's SECTION_GROUPS, unchanged) and makes no
// request itself: the four things it can do are handed in by BeeHub, which
// calls the same three /api/templates routes the old page called.
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import { T, R, FONT, SHADOW, alpha } from '@/components/design/tokens'
import { IconPhone } from '@/components/ui/icons'
import { Pill, Btn, Notice, IconPlus, IconPencil, IconTrash } from '@/components/settings/SettingsShell'
import { parseCallScript, serializeCallScript, callScriptSummary, cleanMins, CALL_SCRIPT_STAGE_NAMES } from '@/lib/call-script'

// The sentence the brief pins. One place, used on the list and in the editor.
export const BRACES_LINE = 'Words in {{braces}} are filled in by you on the call.'
export const NOT_SENT_LINE = 'Talking points for winning new business. Nothing here is sent to anyone.'

// What inline styles cannot say. Every selector starts with
// [data-call-scripts], so nothing outside this page can match. The font-size
// rules carry !important because app/globals.css forces 16px onto every
// input, textarea and button.
export const CALL_SCRIPTS_CSS = `
[data-call-scripts] [data-cs-head]{padding:16px;gap:12px}
[data-call-scripts] [data-cs-body]{padding:16px}
[data-call-scripts] [data-cs-head]:hover{background-color:${T.muted}}
[data-call-scripts] textarea[data-cs-input]{font-size:16px!important}
[data-call-scripts] [data-cs-stage-grid]{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}
[data-call-scripts] [data-cs-top]{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
@media (min-width:640px){
[data-call-scripts] [data-cs-head]{padding:20px;gap:16px}
[data-call-scripts] [data-cs-body]{padding:20px}
[data-call-scripts] textarea[data-cs-input]{font-size:14px!important}
[data-call-scripts] [data-cs-top]{grid-template-columns:minmax(0,1fr) 160px}
}
`

const draw = (children) => function Icon({ size = 16, style = {} }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink:0, display:'block', ...style }}>
      {children}
    </svg>
  )
}
const IconChevronDown = draw(<path d="M6 9l6 6l6 -6" />)
const IconCopy = draw(<><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0 -2 -2H6a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2" /></>)
const IconX = draw(<><path d="M18 6L6 18" /><path d="M6 6l12 12" /></>)

const keyOf = (tpl) => tpl.dbId || tpl.id
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''))

// The scripts this page lists, in order: the location's own first (they
// wrote them), then Bee Organized's. Switched-off rows are never listed.
// `locationId` is for corporate, who is handed EVERY location's rows and for
// whom none is flagged as their own: it names the location being looked at,
// so that location's scripts are the "own" ones and no other location's show.
export function listCallScripts(templates, locationId = null) {
  const live = (templates || []).filter(t => t && t.type === 'call' && t.isActive !== false)
  const own = live.filter(t => !t.isMaster && (t.isOwnCustom || (!!locationId && t.locationUuid === locationId))).sort(byName)
  const masters = live.filter(t => t.isMaster).sort(byName)
  return { own, masters, all: [...own, ...masters] }
}

const inputStyle = { width:'100%', minWidth:0, minHeight:'44px', boxSizing:'border-box', borderRadius:R.md, border:`1px solid ${T.border}`, background:T.card, padding:'8px 12px', lineHeight:'24px', color:T.foreground, fontFamily:FONT.ui, outline:'none' }
const labelStyle = { display:'block', marginBottom:'4px', fontSize:'13px', lineHeight:'18px', fontWeight:700, color:T.foreground }

// ── Writing or changing a script ──────────────────────────────────────────
// `tpl` is the row being changed, or null for a new one. `onSave` is handed
// { name, body } and answers { ok } or { ok:false, error }.
function ScriptEditor({ tpl, isMaster, onSave, onCancel }) {
  const start = React.useMemo(() => {
    const parsed = parseCallScript(tpl ? tpl.body : '')
    return {
      name: tpl ? tpl.name || '' : '',
      when: parsed.when,
      mins: parsed.mins == null ? '' : String(parsed.mins),
      stages: parsed.stages.length ? parsed.stages.map(s => ({ ...s })) : [{ name:'Open', text:'' }],
    }
  }, [tpl])
  const [name, setName] = React.useState(start.name)
  const [when, setWhen] = React.useState(start.when)
  const [mins, setMins] = React.useState(start.mins)
  const [stages, setStages] = React.useState(start.stages)
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState('')

  const setStage = (n, patch) => setStages(prev => prev.map((s, k) => k === n ? { ...s, ...patch } : s))
  const addStage = () => setStages(prev => {
    const used = new Set(prev.map(s => s.name.trim().toLowerCase()))
    const next = CALL_SCRIPT_STAGE_NAMES.find(nm => !used.has(nm.toLowerCase())) || ''
    return [...prev, { name: next, text:'' }]
  })
  const removeStage = (n) => setStages(prev => prev.filter((_, k) => k !== n))

  const minsBad = mins.trim() !== '' && cleanMins(mins) == null
  const hasWords = stages.some(s => s.text.trim())
  const canSave = !!name.trim() && hasWords && !minsBad && !busy

  async function save() {
    if (!canSave) return
    setBusy(true); setErr('')
    const body = serializeCallScript({ when, mins: cleanMins(mins), stages })
    const res = await onSave({ name: name.trim(), body })
    setBusy(false)
    if (!res || res.ok === false) setErr((res && res.error) || 'That did not save. Nothing was changed.')
  }

  return (
    <section data-cs-editor aria-label={tpl ? `Edit ${tpl.name}` : 'New script'}
      style={{ borderRadius:R.xxl, border:`1px solid ${T.gold}`, background:T.card, boxShadow:SHADOW.pop, minWidth:0 }}>
      <div data-cs-body style={{ display:'flex', flexDirection:'column', gap:'16px' }}>
        <div>
          <p style={{ marginBottom:'4px', fontSize:'11px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.14em', color:T.gold, fontFamily:FONT.ui }}>{tpl ? 'Edit script' : 'New script'}</p>
          <p style={{ fontFamily:FONT.body, fontSize:'13px', lineHeight:1.625, color:T.mutedFg }}>{BRACES_LINE} Bee Hub never fills them in and never sends a script to anyone.</p>
        </div>

        {isMaster && (
          <Notice tone="warn" data-cs-master-warning>This is one of Bee Organized’s scripts. A change here changes it for every location.</Notice>
        )}

        <label style={{ display:'block', minWidth:0 }}>
          <span style={labelStyle}>Title</span>
          <input data-sinput data-cs-field="name" value={name} onChange={e => setName(e.target.value)} placeholder="New lead callback" maxLength={120} style={inputStyle} />
        </label>

        <div data-cs-top>
          <label style={{ display:'block', minWidth:0 }}>
            <span style={labelStyle}>When to use it</span>
            <input data-sinput data-cs-field="when" value={when} onChange={e => setWhen(e.target.value)} placeholder="Within 5 minutes of a website lead" maxLength={160} style={inputStyle} />
          </label>
          <label style={{ display:'block', minWidth:0 }}>
            <span style={labelStyle}>About how many minutes</span>
            <input data-sinput data-cs-field="mins" value={mins} onChange={e => setMins(e.target.value)} inputMode="numeric" placeholder="4" maxLength={3}
              aria-invalid={minsBad || undefined} style={{ ...inputStyle, borderColor: minsBad ? T.destructive : T.border }} />
            {minsBad && <span data-cs-mins-error style={{ display:'block', marginTop:'4px', fontSize:'12px', lineHeight:'16px', color:T.destructive }}>A whole number from 1 to 120, or leave it empty.</span>}
          </label>
        </div>

        <div>
          <p style={{ ...labelStyle, marginBottom:'2px' }}>Stages</p>
          <p style={{ marginBottom:'12px', fontSize:'12px', lineHeight:'16px', color:T.mutedFg }}>What you say, in the order you say it. Give each part a short name, such as Open or Close.</p>
          <ol data-cs-edit-stages style={{ listStyle:'none', margin:0, padding:0, display:'flex', flexDirection:'column', gap:'12px' }}>
            {stages.map((s, n) => (
              <li key={n} data-cs-edit-stage style={{ display:'flex', gap:'12px', minWidth:0 }}>
                <span aria-hidden="true" style={{ display:'grid', placeItems:'center', width:'24px', height:'24px', marginTop:'10px', flexShrink:0, borderRadius:R.full, background:T.primary, color:T.primaryFg, fontSize:'11px', fontWeight:700 }}>{n + 1}</span>
                <div data-cs-stage-grid style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', gap:'8px', alignItems:'center', minWidth:0 }}>
                    <input data-sinput data-cs-field="stage-name" aria-label={`Stage ${n + 1} name`} value={s.name} onChange={e => setStage(n, { name: e.target.value })} placeholder="Name this part" maxLength={40} list="cs-stage-names"
                      style={{ ...inputStyle, flex:1 }} />
                    {stages.length > 1 && (
                      <button type="button" data-sbtn="danger-icon" data-cs-remove-stage aria-label={`Remove stage ${n + 1}`} title="Remove this stage" onClick={() => removeStage(n)}
                        style={{ display:'grid', placeItems:'center', width:'44px', height:'44px', flexShrink:0, padding:0, borderRadius:R.md, border:'none', background:'transparent', color:T.destructive, cursor:'pointer' }}>
                        <IconX size={16} />
                      </button>
                    )}
                  </div>
                  <textarea data-cs-input data-cs-field="stage-text" aria-label={`Stage ${n + 1} words`} value={s.text} onChange={e => setStage(n, { text: e.target.value })} rows={3}
                    placeholder="Hi {{first_name}}, this is {{owner_name}} with Bee Organized…"
                    style={{ ...inputStyle, minHeight:'88px', lineHeight:1.5, resize:'vertical', fontFamily:FONT.body }} />
                </div>
              </li>
            ))}
          </ol>
          <datalist id="cs-stage-names">{CALL_SCRIPT_STAGE_NAMES.map(nm => <option key={nm} value={nm} />)}</datalist>
          <div style={{ marginTop:'12px' }}>
            <Btn variant="outline" icon={<IconPlus size={16} />} data-cs-add-stage onClick={addStage}>Add a stage</Btn>
          </div>
        </div>

        {err && <Notice tone="danger" role="alert" data-cs-error>{err}</Notice>}

        <div data-sactions style={{ justifyContent:'flex-end' }}>
          <Btn variant="outline" data-cs-cancel onClick={onCancel} disabled={busy}>Cancel</Btn>
          <Btn variant="primary" data-cs-save onClick={save} disabled={!canSave}>{busy ? 'Saving…' : 'Save script'}</Btn>
        </div>
      </div>
    </section>
  )
}

// ── One script in the list ────────────────────────────────────────────────
function ScriptCard({ tpl, n, open, onToggle, canEdit, canEditMasters, canCopy, onEdit, onDelete, onCopy }) {
  const script = React.useMemo(() => parseCallScript(tpl.body), [tpl.body])
  const summary = callScriptSummary(script)
  const [confirming, setConfirming] = React.useState(false)
  const [busy, setBusy] = React.useState('')
  const [err, setErr] = React.useState('')
  const bodyId = `call-script-${n}`
  const mine = !tpl.isMaster

  async function run(what, fn) {
    setBusy(what); setErr('')
    const res = await fn()
    setBusy('')
    if (!res || res.ok === false) setErr((res && res.error) || 'That did not work. Nothing was changed.')
    return res
  }

  return (
    <section data-cs-card data-cs-kind={mine ? 'own' : 'master'}
      style={{ overflow:'hidden', borderRadius:R.xxl, border:`1px solid ${open ? T.gold : T.border}`, background:T.card, boxShadow: open ? SHADOW.pop : 'none', minWidth:0, transition:'border-color .15s, box-shadow .15s' }}>
      <button type="button" data-cs-head aria-expanded={open} aria-controls={bodyId} onClick={onToggle}
        style={{ display:'flex', alignItems:'center', width:'100%', minHeight:'44px', boxSizing:'border-box', border:'none', background:'transparent', textAlign:'left', cursor:'pointer', fontFamily:FONT.ui, color:T.foreground, transition:'background-color .15s' }}>
        <span aria-hidden="true" style={{ display:'grid', placeItems:'center', width:'40px', height:'40px', flexShrink:0, borderRadius:R.xl, background:T.goldSoft, color:T.warning }}><IconPhone size={16} /></span>
        <span style={{ display:'block', flex:1, minWidth:0 }}>
          <span data-cs-title style={{ display:'block', fontSize:'16px', lineHeight:'24px', fontWeight:700, overflowWrap:'anywhere' }}>{tpl.name}</span>
          {summary && <span data-cs-summary style={{ display:'block', fontSize:'12px', lineHeight:'16px', color:T.mutedFg, overflowWrap:'anywhere' }}>{summary}</span>}
        </span>
        <span style={{ display:'block', flexShrink:0 }}>{mine ? <Pill tone="own" data-cs-pill>Yours</Pill> : <Pill tone="shared" data-cs-pill>Bee Organized</Pill>}</span>
        <span aria-hidden="true" style={{ display:'block', flexShrink:0, color:T.mutedFg, transform: open ? 'rotate(180deg)' : 'none', transition:'transform .15s' }}><IconChevronDown size={16} /></span>
      </button>

      {open && (
        <div id={bodyId} data-cs-body style={{ borderTop:`1px solid ${T.border}`, background:alpha(T.muted, 0.4) }}>
          {script.stages.length === 0 ? (
            <p data-cs-empty-script style={{ fontFamily:FONT.body, fontSize:'14px', lineHeight:1.625, color:T.mutedFg }}>This script has no words yet.</p>
          ) : (
            <ol data-cs-stages style={{ listStyle:'none', margin:0, padding:0, display:'flex', flexDirection:'column', gap:'12px' }}>
              {script.stages.map((s, k) => (
                <li key={k} data-cs-stage style={{ display:'flex', gap:'12px', minWidth:0 }}>
                  <span aria-hidden="true" style={{ display:'grid', placeItems:'center', width:'24px', height:'24px', flexShrink:0, borderRadius:R.full, background:T.primary, color:T.primaryFg, fontSize:'11px', fontWeight:700 }}>{k + 1}</span>
                  <div style={{ minWidth:0, overflowWrap:'anywhere' }}>
                    {s.name && <p data-cs-stage-name style={{ fontSize:'11px', lineHeight:'16px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.14em', color:T.gold, fontFamily:FONT.ui }}>{s.name}</p>}
                    <p data-cs-stage-text style={{ fontFamily:FONT.body, fontSize:'14px', lineHeight:1.625, color:T.foreground, whiteSpace:'pre-wrap' }}>{s.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {err && <div style={{ marginTop:'12px' }}><Notice tone="danger" role="alert" data-cs-error>{err}</Notice></div>}

          {confirming ? (
            <div style={{ marginTop:'16px' }}>
              <Notice tone="danger" data-cs-confirm actions={<>
                <Btn variant="outline" data-cs-keep onClick={() => setConfirming(false)} disabled={!!busy}>Keep it</Btn>
                <Btn variant="danger" data-cs-delete-yes disabled={!!busy} onClick={async () => { const r = await run('delete', onDelete); if (!r || r.ok === false) setConfirming(false) }}>{busy === 'delete' ? 'Deleting…' : 'Delete script'}</Btn>
              </>}>Delete “{tpl.name}”? It cannot be brought back.</Notice>
            </div>
          ) : (
            <div data-sactions data-cs-actions style={{ marginTop:'16px' }}>
              {mine && canEdit && <Btn variant="outline" icon={<IconPencil size={14} />} data-cs-edit onClick={onEdit}>Edit</Btn>}
              {mine && canEdit && <Btn variant="outline" icon={<IconTrash size={14} />} data-cs-delete onClick={() => { setErr(''); setConfirming(true) }}>Delete</Btn>}
              {!mine && canCopy && <Btn variant="outline" icon={<IconCopy size={14} />} data-cs-copy disabled={!!busy} onClick={() => run('copy', onCopy)}>{busy === 'copy' ? 'Copying…' : 'Make my own copy'}</Btn>}
              {!mine && canEditMasters && <Btn variant="outline" icon={<IconPencil size={14} />} data-cs-edit-master onClick={onEdit}>Edit for every location</Btn>}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// ── The page ──────────────────────────────────────────────────────────────
//   templates        every template the caller may see (BeeHub's list)
//   locationId       for corporate only: the location being looked at
//   loading / error  the state of that list
//   canEdit          may write, change and delete this location's own scripts
//   canCopy          may take a copy of one of Bee Organized's (needs a location)
//   canEditMasters   corporate, as themselves: may change one of Bee Organized's
//   onCreate({name, body})        → { ok, tpl } | { ok:false, error }
//   onUpdate(tpl, {name, body})   → the same
//   onDelete(tpl)                 → { ok } | { ok:false, error }
//   onCopy(master)                → { ok, tpl } | { ok:false, error }
export function CallScripts({ templates, locationId = null, loading = false, error = null, canEdit = false, canCopy = false, canEditMasters = false, onCreate, onUpdate, onDelete, onCopy }) {
  const { own, masters, all } = React.useMemo(() => listCallScripts(templates, locationId), [templates, locationId])
  // Which script is open: its key, '' for none, or undefined for "not chosen
  // yet", which opens the first one — the export opens on its first script.
  const [openKey, setOpenKey] = React.useState(undefined)
  // null, 'new', or the key of the script being changed.
  const [editing, setEditing] = React.useState(null)
  const shownOpen = openKey === undefined ? (all[0] ? keyOf(all[0]) : '') : openKey
  const editingTpl = editing && editing !== 'new' ? all.find(t => keyOf(t) === editing) : null

  return (
    <div data-call-scripts style={{ display:'flex', flexDirection:'column', gap:'24px', minWidth:0 }}>
      <style>{CALL_SCRIPTS_CSS}</style>

      <div data-cs-bar style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:'12px', minWidth:0 }}>
        {!loading && !error && <Pill tone="own" data-cs-count>{all.length} {all.length === 1 ? 'script' : 'scripts'}</Pill>}
        <span data-cs-braces style={{ flex:'1 1 200px', minWidth:0, fontSize:'12px', lineHeight:'16px', color:T.mutedFg }}>{BRACES_LINE}</span>
        {canEdit && <Btn variant="primary" icon={<IconPlus size={16} />} data-cs-new disabled={editing === 'new'} onClick={() => setEditing('new')} style={{ marginLeft:'auto' }}>New script</Btn>}
      </div>

      {editing === 'new' && (
        <ScriptEditor tpl={null} isMaster={false} onCancel={() => setEditing(null)}
          onSave={async (data) => { const r = await onCreate(data); if (r && r.ok !== false) { setEditing(null); if (r.tpl) setOpenKey(keyOf(r.tpl)) } return r }} />
      )}

      {loading ? (
        <p data-cs-loading style={{ fontFamily:FONT.body, fontSize:'14px', lineHeight:'20px', color:T.mutedFg }}>Loading your scripts…</p>
      ) : error ? (
        <Notice tone="danger" role="alert" data-cs-load-error>Your scripts could not be loaded. Reload the page to try again.</Notice>
      ) : all.length === 0 ? (
        editing !== 'new' && (
          <div data-cs-none style={{ borderRadius:R.xxl, border:`1px dashed ${T.input}`, background:T.card, padding:'32px 20px', textAlign:'center' }}>
            <p style={{ fontSize:'16px', lineHeight:'24px', fontWeight:700, color:T.foreground }}>No call scripts yet</p>
            <p style={{ marginTop:'4px', fontFamily:FONT.body, fontSize:'13px', lineHeight:1.625, color:T.mutedFg }}>{canEdit ? 'Write your first one with New script.' : 'There is nothing here to read yet.'}</p>
          </div>
        )
      ) : (
        <div data-cs-list style={{ display:'flex', flexDirection:'column', gap:'12px', minWidth:0 }}>
          {all.map((tpl, n) => {
            const k = keyOf(tpl)
            if (editingTpl && k === editing) {
              return <ScriptEditor key={k} tpl={tpl} isMaster={!!tpl.isMaster} onCancel={() => setEditing(null)}
                onSave={async (data) => { const r = await onUpdate(tpl, data); if (r && r.ok !== false) { setEditing(null); setOpenKey(k) } return r }} />
            }
            return (
              <ScriptCard key={k} tpl={tpl} n={n} open={shownOpen === k}
                onToggle={() => setOpenKey(shownOpen === k ? '' : k)}
                canEdit={canEdit} canCopy={canCopy} canEditMasters={canEditMasters}
                onEdit={() => setEditing(k)}
                onDelete={() => onDelete(tpl)}
                onCopy={async () => { const r = await onCopy(tpl); if (r && r.ok !== false && r.tpl) { setOpenKey(keyOf(r.tpl)); setEditing(keyOf(r.tpl)) } return r }} />
            )
          })}
        </div>
      )}

      {!loading && !error && own.length === 0 && masters.length > 0 && canCopy && (
        <p data-cs-hint style={{ textAlign:'center', fontSize:'13px', lineHeight:'18px', color:T.mutedFg }}>These are Bee Organized’s scripts. Make your own copy of one to change the words, or write a new one.</p>
      )}
    </div>
  )
}
