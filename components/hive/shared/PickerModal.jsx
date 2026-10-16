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
//   sections    — tags: group the options into Relationship (list order)
//                 and Trade (A–Z) by each row's attrs.section (lib/tags.ts)
//                 instead of corporate / location's own. A row with no
//                 section shows under Trade — never dropped.
//                 With allowCreate, the tag create flow (2026-10-16): as the
//                 owner types, a near-match (lib/tags.ts tagKey — case,
//                 spacing, punctuation, plurals) replaces "Create" with
//                 "Use <tag>" (an active tag) or "Restore <tag>" (their own
//                 switched-off one). A switched-off CORPORATE match says
//                 "Corporate retired <tag>" and still offers Create — the
//                 server files the request to bring it back. A new tag
//                 belongs to this location alone ("<Location>'s own").
//                 Create is never one keystroke away: the Create row (or
//                 Enter) opens a confirm card that names the tag, says only
//                 this location will see it, and offers the curated icon
//                 grid; only its Create button creates.
//   showIcons   — draw each option's own icon before its label (tags:
//                 "🏠 Realtor"). Off by default — tier and stage rows
//                 carry icons too, and those pickers never showed them.
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
import { tagText } from './tagText'
import { sectionTags, nearTagVerdict } from '@/lib/tags'
import TagIconGrid from './TagIconGrid'

export default function PickerModal({
  category,
  locationId = null,
  selected = [],
  mode = 'multi',
  allowCreate = false,
  maxSelected = null,
  showIcons = false,
  sections = false,
  title = 'Choose',
  subtitle = null,
  onSave = () => {},
  onClose = () => {},
}) {
  const [options, setOptions] = useState(null)     // null = loading
  // Tags only: switched-off rows (corporate retired + this location's own
  // removed) — never options, only for the near-match warnings.
  const [inactive, setInactive] = useState([])
  const [locationName, setLocationName] = useState(null)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(() => new Set(selected))
  const [busy, setBusy] = useState(null)           // 'create' | 'save' | null
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)       // a quiet success note (tag create)
  // Tags: the create confirm card + its icon (curated grid, '' = none).
  const [confirmCreate, setConfirmCreate] = useState(false)
  const [newIcon, setNewIcon] = useState('')
  const searchRef = useRef(null)
  const titleId = useId()

  // Load the scoped vocabulary once per open.
  useEffect(() => {
    let dead = false
    const params = new URLSearchParams({ category })
    if (locationId) params.set('location_id', locationId)
    if (sections) params.set('include_inactive', '1')
    fetch(`/api/lookups?${params.toString()}`)
      .then(r => r.json())
      .then(j => {
        if (dead) return
        const rows = (j.lookups || []).filter(l => l.is_active !== false)
        setOptions(rows)
        setInactive((j.lookups || []).filter(l => l.is_active === false))
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

  // Tags: Relationship / Trade instead of corporate / own (both kinds of
  // row go into whichever section they belong to).
  const sectioned = useMemo(
    () => (sections ? sectionTags([...corporate, ...own], locationName ? `${locationName}'s own` : null) : null),
    [sections, corporate, own, locationName]
  )

  // The create row shows only when the trimmed text matches NO existing
  // label exactly (case-insensitive) — search-narrowing alone must not
  // offer to duplicate a hidden option.
  const createLabel = q.trim()
  // Tags: what the typed name collides with (any option, plus switched-off
  // ones). 'use' / 'restore' replace the create row; 'retired' warns but
  // still lets them create. serverVerdict: the server's own 409 (a race,
  // or a tag this list didn't have) — it wins.
  const [serverVerdict, setServerVerdict] = useState(null)
  useEffect(() => { setServerVerdict(null); setConfirmCreate(false) }, [createLabel])
  const verdict = useMemo(() => {
    if (!sections || !createLabel || options == null) return { kind: 'none' }
    if (serverVerdict) return serverVerdict
    return nearTagVerdict(createLabel, [...options, ...inactive])
  }, [sections, createLabel, options, inactive, serverVerdict])
  const showCreate = allowCreate && !!locationId && !!createLabel && !busy &&
    options != null &&
    !options.some(o => o.label.toLowerCase() === createLabel.toLowerCase()) &&
    verdict.kind !== 'use' && verdict.kind !== 'restore'

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
        body: JSON.stringify({ category, label: createLabel, location_id: locationId, ...(sections && newIcon ? { icon: newIcon } : {}) }),
      })
      const j = await res.json().catch(() => ({}))
      // The server's near-match guard (a race, or a tag this list didn't
      // load): offer what it found instead of failing.
      if (res.status === 409 && j?.error === 'near_match' && j.tag) {
        setServerVerdict({ kind: j.verdict, tag: j.tag })
        return
      }
      if (!res.ok || !j.lookup) throw new Error(j?.error || `HTTP ${res.status}`)
      setOptions(prev => [...(prev || []), j.lookup])
      announceTag(j.lookup)
      setConfirmCreate(false); setNewIcon('')
      if (j.retired) setNotice(`Created. Corporate has been told you needed “${j.retired.label}”.`)
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

  // A tag created (or restored) here joins the app's loaded tag list at once
  // (BeeHub listens), so filters and row labels show it without a reload.
  function announceTag(row) {
    if (!sections || typeof window === 'undefined') return
    try { window.dispatchEvent(new CustomEvent('bee:tag-added', { detail: { ...row, ownerName: locationName } })) } catch {}
  }

  // Tags: pick the existing near-match instead of creating a near-duplicate.
  function useExisting(tag) {
    setError(null)
    setSel(prev => {
      if (prev.has(tag.id)) return prev
      if (mode === 'multi' && maxSelected != null && prev.size >= maxSelected) { setError(`Up to ${maxSelected} can be selected`); return prev }
      const next = new Set(mode === 'single' ? [] : prev); next.add(tag.id); return next
    })
    setQ(''); searchRef.current?.focus()
  }

  // Tags: switch the location's own removed tag back on and pick it.
  async function restoreOwn(tag) {
    setBusy('create'); setError(null)
    try {
      const res = await fetch(`/api/lookups/${tag.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: true }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.lookup) throw new Error(j?.error || `HTTP ${res.status}`)
      const row = { ...tag, ...j.lookup, location_id: tag.location_id ?? j.lookup.location_id, is_active: true }
      setInactive(prev => prev.filter(o => o.id !== tag.id))
      setOptions(prev => [...(prev || []), row])
      announceTag(row)
      setServerVerdict(null)
      useExisting(row)
    } catch (e) {
      setError(`Restore failed: ${e.message}`)
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

  const nearRowStyle = {
    display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
    padding: '7px 8px', borderRadius: T.radius.control, border: 'none',
    background: 'transparent', textAlign: 'left', color: T.accent.deep,
    fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
  }
  const nearIconStyle = { width: '16px', display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }

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
        {showIcons ? tagText(o) : o.label}
      </button>
    )
  }

  return (
    <div className="bee-picker-modal"
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

        <input ref={searchRef} type="text" value={q} placeholder={allowCreate ? 'Search or add' : 'Search'}
          aria-label="Search options"
          onChange={e => { setQ(e.target.value); setError(null) }}
          // Tags: Enter only OPENS the confirm card — it never creates.
          onKeyDown={e => { if (e.key === 'Enter' && showCreate) { e.preventDefault(); if (sections) setConfirmCreate(true); else createOption() } }}
          style={{ ...wizInput(), marginTop: '12px' }}
        />

        <div style={{ overflowY: 'auto', overscrollBehavior: 'contain', margin: '12px -8px 0', padding: '0 8px', flex: 1, minHeight: '80px' }}>
          {options == null && <p style={{ fontSize: '12px', color: T.ink.quiet, padding: '8px 0' }}>Loading…</p>}
          {options != null && sectioned && (
            <>
              {sectioned.map((sec, i) => (
                <div key={sec.key} data-section={sec.key}
                  style={{ borderTop: i > 0 ? T.border.divider : 'none', paddingTop: i > 0 ? '10px' : 0, marginBottom: '12px' }}>
                  {groupHeader(sec.label)}
                  <p style={{ fontSize: '11px', color: T.ink.quiet, margin: '-2px 0 4px' }}>{sec.hint}</p>
                  {sec.rows.map(optionRow)}
                </div>
              ))}
              {/* ── the tag create flow (allowCreate) ── */}
              {verdict.kind === 'use' && !matches(verdict.tag) && (
                <button type="button" data-near="use" onClick={() => useExisting(verdict.tag)} style={nearRowStyle}>
                  <span aria-hidden style={nearIconStyle}><IconCheck size={14} /></span>
                  <span>Use {showIcons ? tagText(verdict.tag) : verdict.tag.label} — it’s already a tag</span>
                </button>
              )}
              {verdict.kind === 'restore' && allowCreate && (
                <button type="button" data-near="restore" onClick={() => restoreOwn(verdict.tag)} disabled={!!busy} style={nearRowStyle}>
                  <span aria-hidden style={nearIconStyle}><IconPlus size={14} /></span>
                  <span>You removed “{verdict.tag.label}” — restore it</span>
                </button>
              )}
              {verdict.kind === 'retired' && allowCreate && (
                <p data-near="retired" style={{ fontSize: '12px', color: T.ink.muted, margin: '2px 0 6px', lineHeight: 1.4 }}>
                  Corporate retired “{verdict.tag.label}”. Creating your own lets corporate know you need it.
                </p>
              )}
              {showCreate && !confirmCreate && (
                <button type="button" data-create onClick={() => setConfirmCreate(true)} style={nearRowStyle}>
                  <span aria-hidden style={nearIconStyle}><IconPlus size={14} /></span>
                  <span>
                    {`Create "${createLabel}"`}
                    <span style={{ display: 'block', fontSize: '11px', fontWeight: 400, color: T.ink.quiet }}>
                      Only {locationName || 'your location'} will see it
                    </span>
                  </span>
                </button>
              )}
              {showCreate && confirmCreate && (
                <div data-create-confirm role="group" aria-label={`Create ${createLabel}`}
                  style={{ padding: '10px', borderRadius: T.radius.inset, border: T.border.thin, background: T.surface.sunken, display: 'flex', flexDirection: 'column', gap: '8px', margin: '4px 0' }}>
                  <p style={{ fontSize: '13px', color: T.ink.primary, margin: 0 }}>
                    Create {newIcon ? `${newIcon} ` : ''}<strong>“{createLabel}”</strong>? Only {locationName || 'your location'} will see it.
                  </p>
                  <TagIconGrid value={newIcon} onChange={setNewIcon} label="Icon for the new tag" />
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button type="button" data-create-go onClick={createOption} disabled={busy === 'create'} style={wizAccentBtn(busy === 'create')}>
                      {busy === 'create' ? 'Creating…' : 'Create'}
                    </button>
                    <button type="button" onClick={() => setConfirmCreate(false)} style={wizQuietBtn()}>Cancel</button>
                  </div>
                </div>
              )}
              {notice && <p style={{ fontSize: '12px', color: T.ink.muted, margin: '4px 0' }}>{notice}</p>}
              {sectioned.length === 0 && !showCreate && verdict.kind === 'none' && (
                <p style={{ fontSize: '12px', color: T.ink.quiet, padding: '8px 0' }}>
                  {needle ? 'No matches' : 'No options yet'}
                </p>
              )}
            </>
          )}
          {options != null && !sectioned && (
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
