// components/hive/shared/PickerModal.jsx
// ─────────────────────────────────────────────────────────────
// THE reusable lookup picker (tag system step 2A) — a CENTERED modal
// over a scrim (deliberately not a popover/dropdown/sheet: one picker
// anatomy for every lookup vocabulary, starting with tags).
//
// Fetches its own options from /api/lookups?category=…&location_id=…
// (the route scopes to corporate + that location — never another
// location's rows) and renders TWO groups: the corporate standard
// options (location_id null) first, then "<Location name>'s own"
// (location_id = locationId). Search filters both groups at once.
//
// allowCreate: when the search text matches no option label, a create
// row appears (Enter also fires it). A created option ALWAYS goes to
// the CURRENT location (POST /api/lookups with location_id) — an owner
// can never mint a corporate option from here; corporate vocabulary
// stays a Configure-tab concern.
//
// Selection is staged: toggles are local until Save hands the picked
// option objects to onSave (multi → array; single → one option or
// null). onSave may be async — the modal shows the in-flight state,
// closes itself when onSave resolves, and stays open showing the error
// when it throws. The modal never writes junction rows itself.
//
// props:
//   category    — lookups category to fetch and create within
//   locationId  — uuid of the location whose own options show/create
//   selected    — array of lookup ids OR attrs.key slugs already applied
//                 (partners store tier/specialties as attrs.key — values
//                 are normalized to option ids once the fetch lands; a
//                 value matching NO option keeps nothing checked and is
//                 dropped on save — saving asserts the new set)
//   mode        — 'multi' (checklist) | 'single' (one choice)
//   allowCreate — offer the create row on unmatched search text
//   maxSelected — multi only: cap; the blocked toggle explains itself
//                 BEFORE save, never a post-save surprise (step 2B, the
//                 8-specialty cap the conversion route enforces)
//   title, subtitle — header copy
//   onSave(picked), onClose()
//
// tokens.js only; wizard footer buttons reused from CloseWizardKit.
// §8.5: props only, no context. Beta chunk.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useMemo, useRef, useState, useId } from 'react'
import { T } from './tokens'
import { wizAccentBtn, wizQuietBtn, wizInput } from './CloseWizardKit'
import { IconCheck, IconPlus } from '@/components/ui/icons'

export default function PickerModal({
  category,
  locationId = null,
  selected = [],
  mode = 'multi',
  allowCreate = false,
  maxSelected = null,
  title = 'Choose',
  subtitle = null,
  onSave = () => {},
  onClose = () => {},
}) {
  const [options, setOptions] = useState(null)     // null = loading
  const [locationName, setLocationName] = useState(null)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(() => new Set(selected))
  const [busy, setBusy] = useState(null)           // 'create' | 'save' | null
  const [error, setError] = useState(null)
  const searchRef = useRef(null)
  const titleId = useId()

  // Load the scoped vocabulary once per open.
  useEffect(() => {
    let dead = false
    const params = new URLSearchParams({ category })
    if (locationId) params.set('location_id', locationId)
    fetch(`/api/lookups?${params.toString()}`)
      .then(r => r.json())
      .then(j => {
        if (dead) return
        const rows = (j.lookups || []).filter(l => l.is_active !== false)
        setOptions(rows)
        if (j.location?.name) setLocationName(j.location.name)
        // Normalize incoming selected values: hosts may hand attrs.key
        // slugs (partners.tier / .specialties storage) instead of ids.
        setSel(prev => {
          const next = new Set()
          for (const v of prev) {
            const hit = rows.find(o => o.id === v || (o.attrs && o.attrs.key === v))
            next.add(hit ? hit.id : v)
          }
          return next
        })
      })
      .catch(() => { if (!dead) { setOptions([]); setError('Could not load options') } })
    return () => { dead = true }
  }, [category, locationId])

  // Focus lands in the search field; the page behind scroll-locks
  // (OverlayShell pattern — restore whatever was there before).
  useEffect(() => {
    searchRef.current?.focus()
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // Esc closes from anywhere in the dialog.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const needle = q.trim().toLowerCase()
  const matches = (o) => !needle || o.label.toLowerCase().includes(needle)
  const corporate = useMemo(
    () => (options || []).filter(o => !o.location_id && matches(o)),
    [options, needle] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const own = useMemo(
    () => (options || []).filter(o => o.location_id && o.location_id === locationId && matches(o)),
    [options, needle, locationId] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // The create row shows only when the trimmed text matches NO existing
  // label exactly (case-insensitive) — search-narrowing alone must not
  // offer to duplicate a hidden option.
  const createLabel = q.trim()
  const showCreate = allowCreate && !!locationId && !!createLabel && !busy &&
    options != null &&
    !options.some(o => o.label.toLowerCase() === createLabel.toLowerCase())

  function toggle(id) {
    setError(null)
    setSel(prev => {
      if (!prev.has(id) && mode === 'multi' && maxSelected != null && prev.size >= maxSelected) {
        setError(`Up to ${maxSelected} can be selected`)
        return prev
      }
      const next = new Set(mode === 'single' ? [] : prev)
      if (prev.has(id)) { if (mode === 'multi') next.delete(id) }
      else next.add(id)
      return next
    })
  }

  async function createOption() {
    if (!showCreate) return
    setBusy('create'); setError(null)
    try {
      const res = await fetch('/api/lookups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, label: createLabel, location_id: locationId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.lookup) throw new Error(j?.error || `HTTP ${res.status}`)
      setOptions(prev => [...(prev || []), j.lookup])
      setSel(prev => {
        // A created option lands selected — unless that would breach the
        // cap, in which case it lands unchecked (the cap message stands).
        if (mode === 'multi' && maxSelected != null && prev.size >= maxSelected) return prev
        const next = new Set(mode === 'single' ? [] : prev)
        next.add(j.lookup.id)
        return next
      })
      setQ('')
      searchRef.current?.focus()
    } catch (e) {
      setError(`Create failed: ${e.message}`)
    } finally { setBusy(null) }
  }

  async function save() {
    if (busy) return
    setBusy('save'); setError(null)
    try {
      const picked = (options || []).filter(o => sel.has(o.id))
      await onSave(mode === 'single' ? (picked[0] || null) : picked)
      onClose()
    } catch (e) {
      setError(`Save failed: ${e.message}`)
      setBusy(null)
    }
  }

  const groupHeader = (text, corp = false) => (
    <p style={{
      fontSize: '11px', fontWeight: 500, letterSpacing: '0.6px', textTransform: 'uppercase',
      color: corp ? T.corp.fg : T.ink.muted, margin: '0 0 4px',
    }}>
      {text}
    </p>
  )

  const optionRow = (o) => {
    const on = sel.has(o.id)
    return (
      <button key={o.id} type="button" onClick={() => toggle(o.id)}
        role={mode === 'multi' ? 'checkbox' : 'radio'} aria-checked={on}
        style={{
          display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
          padding: '7px 8px', borderRadius: T.radius.control, border: 'none',
          background: on ? T.accent.faint : 'transparent', textAlign: 'left',
          color: on ? T.ink.primary : T.ink.secondary, fontWeight: on ? 500 : 400,
          cursor: 'pointer', fontFamily: 'inherit',
        }}>
        <span aria-hidden style={{ width: '16px', display: 'inline-flex', justifyContent: 'center', color: T.accent.deep, flexShrink: 0 }}>
          {on ? <IconCheck size={14} /> : ''}
        </span>
        {o.label}
      </button>
    )
  }

  return (
    <div className="bee-picker-modal" onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 10010, background: T.surface.scrim, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
      {/* :focus-visible can't be expressed inline — token-interpolated, no literals */}
      <style>{`
        .bee-picker-modal button:focus-visible, .bee-picker-modal input:focus-visible {
          outline: 2px solid ${T.accent.fg}; outline-offset: 2px;
        }
      `}</style>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: '420px', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
          background: T.surface.raised, border: T.border.card, borderRadius: T.radius.card, boxShadow: T.shadow.overlay,
          padding: '20px 20px 16px', boxSizing: 'border-box',
        }}>
        <h2 id={titleId} style={{ fontSize: '17px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle, margin: 0 }}>{title}</h2>
        {subtitle && <p style={{ fontSize: '12px', color: T.ink.muted, margin: '4px 0 0' }}>{subtitle}</p>}

        <input ref={searchRef} type="text" value={q} placeholder="Search or add"
          aria-label="Search options"
          onChange={e => { setQ(e.target.value); setError(null) }}
          onKeyDown={e => { if (e.key === 'Enter' && showCreate) { e.preventDefault(); createOption() } }}
          style={{ ...wizInput(), marginTop: '12px' }}
        />

        <div style={{ overflowY: 'auto', overscrollBehavior: 'contain', margin: '12px -8px 0', padding: '0 8px', flex: 1, minHeight: '80px' }}>
          {options == null && <p style={{ fontSize: '12px', color: T.ink.quiet, padding: '8px 0' }}>Loading…</p>}
          {options != null && (
            <>
              {corporate.length > 0 && (
                <div style={{ marginBottom: own.length > 0 || showCreate ? '12px' : 0 }}>
                  {groupHeader('Corporate standard', true)}
                  {corporate.map(optionRow)}
                </div>
              )}
              {(own.length > 0 || showCreate) && (
                <div style={{ borderTop: corporate.length > 0 ? T.border.divider : 'none', paddingTop: corporate.length > 0 ? '10px' : 0 }}>
                  {groupHeader(`${locationName || 'This location'}'s own`)}
                  {own.map(optionRow)}
                  {showCreate && (
                    <button type="button" onClick={createOption} disabled={busy === 'create'}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
                        padding: '7px 8px', borderRadius: T.radius.control, border: 'none',
                        background: 'transparent', textAlign: 'left', color: T.accent.deep,
                        fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
                      }}>
                      <span aria-hidden style={{ width: '16px', display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
                        <IconPlus size={14} />
                      </span>
                      {busy === 'create' ? 'Creating…' : `Create "${createLabel}"`}
                    </button>
                  )}
                </div>
              )}
              {corporate.length === 0 && own.length === 0 && !showCreate && (
                <p style={{ fontSize: '12px', color: T.ink.quiet, padding: '8px 0' }}>
                  {needle ? 'No matches' : 'No options yet'}
                </p>
              )}
            </>
          )}
        </div>

        {error && <p role="alert" style={{ fontSize: '12px', color: T.state.danger.fg, margin: '8px 0 0' }}>{error}</p>}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', alignItems: 'center', marginTop: '12px', borderTop: T.border.divider, paddingTop: '12px' }}>
          <button type="button" onClick={onClose} style={wizQuietBtn()}>Cancel</button>
          <button type="button" onClick={save} disabled={busy != null || options == null}
            style={wizAccentBtn(busy != null || options == null)}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
