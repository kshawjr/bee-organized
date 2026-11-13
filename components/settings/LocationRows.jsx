// components/settings/LocationRows.jsx
// ─────────────────────────────────────────────────────────────
// Settings → Location — slice 3 of 4 of the Settings rebuild (2026-11-13,
// the export's `Location` page in src/components/settings/pages.tsx).
//
// Three rows the plain EditRow cannot be, and nothing that decides who may
// see them or what is saved (that is SettingsScreen in BeeHub.jsx):
//
//   AddressRow   ONE address field with a typeahead, where there were four
//                rows. The typeahead is Bee Hub's own
//                (components/hive/shared/AddressAutofill.jsx — Google Places,
//                the one a client's address uses), mounted, not rewritten.
//                City, state and ZIP are still FOUR separate values: a pick
//                hands all four to `onSave` in one go, and "enter it by hand"
//                is four labelled boxes for an address the lookup cannot
//                find. Nothing is ever parsed back out of one joined string.
//   SelectRow    a row whose editor is a list (the timezone). A stored value
//                that is not on the list stays on screen and is flagged; it
//                is never blanked or swapped for a guess.
//   ChoiceCards  two or more big either/or buttons (the assessment default).
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import { T, R, FONT, alpha } from '@/components/design/tokens'
import AddressAutofill, { parseAddress } from '@/components/hive/shared/AddressAutofill'
import { Btn, Field, IconPencil, IconCheck, IconCircleCheck } from '@/components/settings/SettingsShell'

const labelStyle = { fontSize:'14px', lineHeight:'20px', fontWeight:700, color:T.foreground, fontFamily:FONT.ui }
const hintStyle = { marginTop:'2px', fontSize:'12px', lineHeight:1.625, color:T.mutedFg, fontFamily:FONT.ui }
const valueStyle = (has) => ({ display:'block', fontSize:'14px', lineHeight:'20px', fontFamily:FONT.ui, textAlign:'left', overflowWrap:'anywhere', minWidth:0, color: has ? T.foreground : T.mutedFg, fontStyle: has ? 'normal' : 'italic' })
const fieldBox = { minHeight:'44px', width:'100%', minWidth:0, boxSizing:'border-box', borderRadius:R.lg, border:`1px solid ${T.border}`, background:T.card, padding:'8px 12px', fontFamily:FONT.ui, color:T.foreground, outline:'none' }

function Saved({ state }) {
  if (state === 'saving') return <span role="status" style={{ flexShrink:0, fontSize:'12px', color:T.mutedFg, fontFamily:FONT.ui }}>Saving…</span>
  if (state !== 'saved') return null
  return (
    <span role="status" style={{ display:'flex', flexShrink:0, alignItems:'center', gap:'4px', fontSize:'12px', fontWeight:700, color:T.success, fontFamily:FONT.ui }}>
      <IconCheck size={14} style={{ verticalAlign:0 }} />Saved
    </span>
  )
}
function Pencil({ label, onClick }) {
  return (
    <button type="button" aria-label={`Edit ${label}`} data-shover="muted" onClick={onClick}
      style={{ display:'grid', placeItems:'center', width:'44px', height:'44px', borderRadius:R.lg, border:'none', background:'transparent', color:T.mutedFg, cursor:'pointer', transition:'background-color .15s' }}>
      <IconPencil size={16} style={{ verticalAlign:0 }} />
    </button>
  )
}
// "Saved" for 1.8s, unless the caller's save answered false.
function useSaveState() {
  const [state, setState] = React.useState(null)
  const alive = React.useRef(true)
  React.useEffect(() => () => { alive.current = false }, [])
  const run = async (save) => {
    setState('saving')
    const ok = await save()
    if (!alive.current) return ok
    setState(ok === false ? null : 'saved')
    if (ok !== false) setTimeout(() => { if (alive.current) setState(s => (s === 'saved' ? null : s)) }, 1800)
    return ok
  }
  return [state, run]
}

// One line for the eye: "101 South Tryon Street, Charlotte, NC 28280".
// Display only — the four parts are what is stored and what is saved.
export function formatLocationAddress({ address, city, state, zip } = {}) {
  const tail = [String(state || '').trim(), String(zip || '').trim()].filter(Boolean).join(' ')
  return [String(address || '').trim(), String(city || '').trim(), tail].filter(Boolean).join(', ')
}

// ── Address ───────────────────────────────────────────────────────────────
// `value` is { address, city, state, zip } as stored. `onSave(parts)` gets the
// same four keys, every one a string (an empty string clears that column),
// and answers false if the write did not land. The row shows `value` only, so
// a refused save leaves the old address on screen.
export function AddressRow({ value, onSave }) {
  const shown = formatLocationAddress(value)
  const [mode, setMode] = React.useState('view')   // 'view' | 'search' | 'hand'
  const [query, setQuery] = React.useState('')
  const [hand, setHand] = React.useState({ address:'', city:'', state:'', zip:'' })
  const [state, run] = useSaveState()
  // The typeahead is mounted as it is and has no "start focused" of its own,
  // so the cursor is put in its box here. Without this, the pencil opened a
  // box you then had to click again before you could type.
  const searchBox = React.useRef(null)
  React.useEffect(() => {
    if (mode === 'search') searchBox.current?.querySelector('input')?.focus()
  }, [mode])

  const close = () => { setMode('view'); setQuery('') }
  const save = async (parts) => {
    const next = {
      address: String(parts.address || '').trim(), city: String(parts.city || '').trim(),
      state: String(parts.state || '').trim(), zip: String(parts.zip || '').trim(),
    }
    close()
    const same = ['address', 'city', 'state', 'zip'].every(k => next[k] === String(value?.[k] || '').trim())
    if (same || !onSave) return
    await run(() => onSave(next))
  }
  // A suggestion was picked: Places hands back the four parts. A unit
  // ("Suite 200") rides on the street line, as it does everywhere else.
  const picked = (p) => save({ address: [p.street, p.apt].filter(Boolean).join(' '), city: p.city, state: p.state, zip: p.zip })
  // By hand: start from what was typed if it reads as an address, otherwise
  // from what is stored, so nothing has to be retyped.
  const openHand = () => {
    const typed = query.trim() ? parseAddress(query.trim()) : null
    setHand(typed && typed.street
      ? { address: typed.street, city: typed.city || '', state: typed.state || '', zip: typed.zip || '' }
      : { address: value?.address || '', city: value?.city || '', state: value?.state || '', zip: value?.zip || '' })
    setMode('hand')
  }
  const set = key => ev => setHand(h => ({ ...h, [key]: ev.target.value }))

  return (
    <div data-srow data-settings-row="Address">
      <div data-srow-label>
        <p style={labelStyle}>Address</p>
        <p style={hintStyle}>Start typing and pick a suggestion — city, state and ZIP fill in for you.</p>
      </div>
      <div style={{ minWidth:0 }}>
        {mode === 'view' && (
          <div style={{ display:'flex', alignItems:'center', gap:'8px', minWidth:0, minHeight:'44px' }}>
            <button type="button" onClick={() => setMode('search')} aria-label={`Address: ${shown || 'Not set'}. Edit`}
              style={{ display:'block', minHeight:'44px', minWidth:0, padding:'8px 0', background:'none', border:'none', borderRadius:R.md, cursor:'text', fontFamily:'inherit', textAlign:'left' }}>
              <span data-row-value style={valueStyle(!!shown)}>{shown || 'Not set'}</span>
            </button>
            <Saved state={state} />
          </div>
        )}

        {mode === 'search' && (
          <div data-address-search ref={searchBox} style={{ display:'flex', flexDirection:'column', gap:'8px' }}>
            {/* Bee Hub's own Places typeahead. Its list of suggestions is its
                own (shared with a client's address), so it is not restyled
                here; the box it types into takes this page's look. */}
            <AddressAutofill value={query} onChange={setQuery} onParsed={picked}
              placeholder="Start typing the street address…"
              onKeyDown={e => { if (e.key === 'Escape') close(); if (e.key === 'Enter') { e.preventDefault(); openHand() } }}
              style={{ ...fieldBox, border:`1px solid ${T.border}` }} />
            <div data-sactions style={{ alignItems:'center' }}>
              <Btn variant="text" data-address-by-hand onClick={openHand}>Can’t find it? Enter it by hand</Btn>
              <Btn data-address-cancel onClick={close} style={{ marginLeft:'auto' }}>Cancel</Btn>
            </div>
          </div>
        )}

        {mode === 'hand' && (
          <form data-address-hand onSubmit={e => { e.preventDefault(); save(hand) }}
            style={{ borderRadius:R.xl, background:T.muted, padding:'16px', display:'flex', flexDirection:'column', gap:'12px' }}>
            <Field label="Street address" autoFocus value={hand.address} onChange={set('address')} />
            <div data-striple>
              <Field label="City" value={hand.city} onChange={set('city')} />
              <Field label="State" value={hand.state} onChange={set('state')} />
              <Field label="ZIP" inputMode="numeric" value={hand.zip} onChange={set('zip')} />
            </div>
            <div data-sactions>
              <Btn variant="primary" type="submit">Save address</Btn>
              <Btn onClick={close}>Cancel</Btn>
            </div>
          </form>
        )}
      </div>
      {mode === 'view' && <Pencil label="Address" onClick={() => setMode('search')} />}
    </div>
  )
}

// ── A row whose editor is a list ──────────────────────────────────────────
// `options` is [{ value, label }]. `onSave(value)` gets the option's VALUE.
export function SelectRow({ label, value, options, hint, invalidHint, onSave }) {
  const [editing, setEditing] = React.useState(false)
  const [state, run] = useSaveState()
  const current = options.find(o => o.value === value) || null
  const invalid = !current
  const choose = async (v) => {
    setEditing(false)
    if (v === value || !options.some(o => o.value === v) || !onSave) return
    await run(() => onSave(v))
  }
  return (
    <div data-srow data-settings-row={label}>
      <div data-srow-label>
        <p style={labelStyle}>{label}</p>
        {hint && <p style={hintStyle}>{hint}</p>}
      </div>
      <div style={{ minWidth:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:'8px', minWidth:0, minHeight:'44px' }}>
          {editing ? (
            <select autoFocus data-sinput aria-label={label} defaultValue={value || ''}
              onChange={e => choose(e.target.value)} onBlur={() => setEditing(false)}
              onKeyDown={e => { if (e.key === 'Escape') setEditing(false) }}
              style={{ ...fieldBox, appearance:'auto' }}>
              {/* A stored value that is not on the list stays visible as the
                  selected, unpickable entry until a real one is chosen. */}
              {invalid && <option value={value || ''} disabled>{value ? `${value} (not valid)` : 'Pick one…'}</option>}
              {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <button type="button" onClick={() => setEditing(true)} aria-label={`${label}: ${current ? current.label : (value || 'Not set')}. Edit`}
              style={{ display:'block', minHeight:'44px', minWidth:0, padding:'8px 0', background:'none', border:'none', borderRadius:R.md, cursor:'pointer', fontFamily:'inherit', textAlign:'left' }}>
              <span data-row-value style={{ ...valueStyle(!!(current || value)), ...(invalid ? { color:T.destructive, fontStyle:'normal' } : null) }}>{current ? current.label : (value || 'Not set')}</span>
            </button>
          )}
          <Saved state={state} />
        </div>
        {invalid && (
          <p data-row-invalid role="alert" style={{ marginTop:'2px', maxWidth:'560px', fontSize:'12px', lineHeight:1.625, color:T.destructive, fontFamily:FONT.ui }}>
            {invalidHint || 'Not a valid choice — pick one from the list.'}
          </p>
        )}
      </div>
      {!editing && <Pencil label={label} onClick={() => setEditing(true)} />}
    </div>
  )
}

// ── Either/or cards ───────────────────────────────────────────────────────
// `choices` is [{ value, label, icon }]. Picking the one already chosen does
// nothing; picking another calls `onChoose(value)`.
export function ChoiceCards({ label, value, choices, onChoose, attr }) {
  return (
    <div role="radiogroup" aria-label={label} data-schoices>
      {choices.map(c => {
        const on = value === c.value
        return (
          <button key={c.value} type="button" role="radio" aria-checked={on} {...{ [attr || 'data-choice']: c.value }}
            data-shover={on ? undefined : 'muted'}
            onClick={() => { if (!on) onChoose(c.value) }}
            style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:'8px', minHeight:'44px', padding:'16px', borderRadius:R.xl, border:`2px solid ${on ? T.primary : T.border}`, background: on ? T.sageSoft : T.card, color: on ? T.primary : T.foreground, cursor:'pointer', fontFamily:FONT.ui, transition:'background-color .15s' }}>
            {c.icon}
            <span style={{ fontSize:'14px', lineHeight:'20px', fontWeight:700 }}>{c.label}</span>
            {on && <IconCircleCheck size={16} />}
          </button>
        )
      })}
    </div>
  )
}

// The quiet line at the foot of the details card: how a person tells support
// which location they are.
export function LocationIdLine({ id }) {
  return (
    <p data-location-id style={{ marginTop:'12px', fontSize:'12px', lineHeight:'18px', color:T.mutedFg, fontFamily:FONT.ui, overflowWrap:'anywhere' }}>
      Location ID <span data-location-id-value style={{ fontFamily:'ui-monospace,SFMono-Regular,Menlo,monospace', color:alpha(T.foreground, 0.8), userSelect:'all' }}>{id || '—'}</span>
      <span style={{ display:'block' }}>Quote this if you ever need to tell us which location you are.</span>
    </p>
  )
}
