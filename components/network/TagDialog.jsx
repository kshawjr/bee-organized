'use client'

// The Network tag picker (Lovable design: brief-and-current,
// src/components/network/TagPicker.tsx, 5336ad0 and after), in Bee Hub's own
// code. A centred box over the contact sheet: one search bar that both finds a
// tag and starts a new one, the eight Network groups as soft chips, and a
// second screen to make the new tag.
//
// Search-to-create (Kevin, 2026-11-16; the design's earlier picker did the
// same): typing narrows the list, and when no tag has exactly that name a
// "Create “name”" row sits at the top of the list. It opens the second screen
// with the name filled in. There is no separate "Create a new tag" button.
//
// It only SHOWS and COLLECTS. It writes nothing itself: the contact sheet
// owns every request (ContactSheet.jsx saveTags / createTag).
//
// Bee Hub's rules, kept (Kevin, 2026-11-15 and 2026-11-16):
//   · a new tag must be given a group: none is picked for the person
//   · Create stays off until there is a name AND a group
//   · a location may have ten tags of its own: at ten the Create row is
//     off and the reason is written above the list (the server refuses too)
//   · a new tag lands ticked
//   · the emoji is optional: one tapped from the grid, one typed, or the
//     group's own
// Where Bee Hub differs from the design, on purpose:
//   · nothing is put on the contact until Done. The ✕ and Escape leave
//     without saving, like every other form on the sheet, so the design's
//     "Remove this tag?" question is not needed.
//   · a tap outside the box does not close it (the sheet's own rule).

import { useEffect, useRef, useState } from 'react'
import { T } from '@/components/design/tokens'
import { NEW_TAG_EMOJI_GROUPS, TAG_LIMIT_PER_LOCATION, firstEmoji, groupEmoji, groupsForScreen, newTagEmoji, tagLimitWords } from '@/lib/tags'
import { tagEmoji } from '@/lib/network/contact-adds'

const S = '[data-network-sheet]'
export const TAG_DIALOG_CSS = `
${S} .td-back{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;padding:16px;background:color-mix(in oklab,${T.primary} 40%,transparent)}
${S} .td{display:flex;flex-direction:column;width:100%;max-width:512px;max-height:min(640px,calc(var(--td-vh,100dvh) - 32px));border:1px solid ${T.border};border-radius:16px;overflow:hidden;background:${T.card};box-shadow:0 24px 60px -20px rgba(26,48,44,.35);animation:td-pop .2s ease-out;outline:none}
@keyframes td-pop{from{opacity:0;transform:scale(.92)}}
${S} .td form{display:flex;flex-direction:column;flex:1;min-height:0;margin:0}
${S} .td-head{display:flex;flex-shrink:0;align-items:center;gap:12px;padding:16px 20px;background:${T.card};color:${T.primary}}
${S} .td-head h2{flex:1;min-width:0;margin:0;font-family:inherit;font-size:18px!important;line-height:28px;font-weight:700;color:${T.primary}}
${S} .td-icon{display:grid;place-items:center;flex-shrink:0;width:44px;height:44px;border-radius:10px;color:${T.mutedFg}}
${S} .td-icon:hover{background:${T.muted};color:${T.primary}}
${S} .td-top{flex-shrink:0;padding:0 20px 12px}
${S} .td-input{min-height:48px;height:48px}
${S} .td-small{margin:8px 0 0;font-size:12px!important;line-height:16px;text-align:right;color:${T.mutedFg}}
${S} .td-create{display:flex;align-items:center;gap:8px;width:100%;min-height:48px;margin-top:16px;padding:8px 12px!important;border:1px dashed color-mix(in oklab,${T.primary} 40%,transparent)!important;border-radius:12px;background:${T.card};color:${T.primary};font-size:14px!important;font-weight:700;letter-spacing:0;text-align:left}
${S} .td-create:hover:not(:disabled){background:${T.sageSoft}}
${S} .td-create:disabled{color:${T.mutedFg};cursor:not-allowed}
${S} .td-create .td-label{min-width:0;overflow-wrap:anywhere}
${S} .td-line{margin:8px 0 0;font-size:14px!important;line-height:20px;color:${T.mutedFg}}
${S} .td-line[data-tone="good"]{color:${T.primary}}
${S} .td-line[role="alert"]{color:${T.destructive}}
${S} .td-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior-y:contain;padding:0 20px 20px}
${S} .td-section{padding-top:18px}
${S} .td-section h3{margin:0 0 10px;font-family:inherit;font-size:13px!important;line-height:1.4;font-weight:700;color:${T.primary};letter-spacing:0;text-transform:none}
${S} .td-section h3 i{margin-left:8px;font-style:normal;font-weight:400;color:${T.mutedFg}}
${S} .td-chips{display:flex;flex-wrap:wrap;gap:8px}
${S} .td-choice{display:inline-flex;align-items:center;gap:8px;min-height:44px;max-width:100%;padding:8px 12px;border-radius:999px;border:1px solid transparent;background:${T.muted};color:${T.primary};font-size:13px!important;font-weight:500;letter-spacing:0;text-align:left}
${S} .td-choice:hover{background:${T.sageSoft}}
${S} .td-choice[aria-checked="true"]{background:${T.sageSoft};border-color:${T.primary};color:${T.primary}}
${S} .td-choice .td-emoji{font-size:18px;line-height:1}
${S} .td-choice .td-label{min-width:0;overflow-wrap:anywhere}
${S} .td-check{display:grid;place-items:center;flex-shrink:0;width:18px;height:18px;border:1px solid ${T.input};border-radius:50%;color:${T.primaryFg}}
${S} .td-choice[aria-checked="true"] .td-check{background:${T.primary};border-color:${T.primary}}
${S} .td-none{margin:0;font-size:12px!important;color:${T.mutedFg}}
${S} .td-nomatch{margin:0;padding:24px 0;text-align:center;font-size:14px!important;color:${T.mutedFg}}
${S} .td-foot{display:flex;flex-shrink:0;align-items:center;gap:8px;padding:16px 20px;border-top:1px solid ${T.border}}
${S} .td-foot .td-count{flex:1;min-width:0;font-size:14px!important;color:${T.mutedFg}}
${S} .td-foot .ns-btn-ghost:hover{background:${T.muted};color:${T.primary}}
${S} .td-make{flex:1;min-height:0;overflow-y:auto;overscroll-behavior-y:contain;display:grid;align-content:start;gap:20px;padding:0 20px 20px}
${S} .td-make label,${S} .td-make legend{display:block;padding:0;font-size:14px!important;font-weight:700;color:${T.primary}}
${S} .td-make label b,${S} .td-make legend b{font-weight:400;color:${T.mutedFg}}
${S} .td-make label .ns-input{margin-top:8px;font-weight:400}
${S} .td-make fieldset{margin:0;padding:0;border:0;min-width:0}
${S} .td-make legend{margin-bottom:12px}
${S} .td-emojirow{display:flex;align-items:center;gap:12px}
${S} .td-emojirow .ns-input{flex:1;min-width:0;min-height:44px;height:44px}
${S} .td-emojis{max-height:220px;margin-top:12px;padding:0 10px 10px;overflow-y:auto;overscroll-behavior-y:contain;border:1px solid ${T.border};border-radius:12px}
${S} .td-emojis p{margin:10px 0 6px;font-size:11px!important;line-height:16px;font-weight:400;letter-spacing:.04em;text-transform:uppercase;color:${T.mutedFg}}
${S} .td-egrid{display:flex;flex-wrap:wrap;gap:4px}
${S} .td-echoice{display:grid;place-items:center;flex-shrink:0;width:44px;height:44px;padding:0!important;border:1px solid ${T.border}!important;border-radius:8px;background:${T.card};font-size:24px!important;line-height:1}
${S} .td-echoice:hover{background:${T.muted}}
${S} .td-echoice[aria-checked="true"]{border-color:${T.primary}!important;box-shadow:0 0 0 2px ${T.primary}}
${S} .td-preview{display:grid;place-items:center;flex-shrink:0;width:44px;height:44px;border-radius:12px;background:${T.muted};font-size:28px;line-height:1}
${S} .td-trigger{display:flex;align-items:center;gap:8px;width:100%;min-height:44px;margin-top:16px;padding:6px 10px!important;border:1px solid ${T.border}!important;border-radius:8px;background:${T.muted}!important;font-size:12px!important;text-align:left}
${S} .td-trigger[data-has="true"]{border-color:${T.primary}!important}
${S} .td-trigger .td-tlabel{display:inline-flex;flex-shrink:0;align-items:center;gap:6px;color:${T.mutedFg}}
${S} .td-trigger .td-tchips{display:flex;flex:1;min-width:0;flex-wrap:wrap;align-items:center;gap:4px;overflow:hidden;color:${T.primary}}
${S} .td-more{color:${T.primary};background:${T.muted};border-color:${T.border}}
${S} .td-after{display:flex;min-height:0;margin-top:6px}
@media (max-width:600px){
  ${S} .td-back{padding:12px}
  ${S} .td{max-height:calc(var(--td-vh,100dvh) - 24px)}
  ${S} .td-head{padding-top:10px;padding-bottom:10px}
}
`

const Icon = ({ children, size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
export const TagsIcon = ({ size }) => <Icon size={size}><path d="m15 5 6.3 6.3a2.4 2.4 0 0 1 0 3.4L17 19" /><path d="M9.586 5.586A2 2 0 0 0 8.172 5H3a1 1 0 0 0-1 1v5.172a2 2 0 0 0 .586 1.414L8.29 18.29a2.426 2.426 0 0 0 3.42 0l3.58-3.58a2.426 2.426 0 0 0 0-3.42z" /><circle cx="6.5" cy="9.5" r=".5" fill="currentColor" /></Icon>
const CheckIcon = ({ size = 14 }) => <Icon size={size}><path d="M20 6 9 17l-5-5" /></Icon>

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]'

/** How many tags of its own this location has. The sheet hands over switched-on tags only. */
export const ownTagCount = (rows) => (rows || []).filter((t) => t.location_id).length

/**
 * list      null (loading) | { problem: true } | { rows, sections }
 * picked    the ticked tag ids; setPicked(ids) changes them
 * create    ({ label, group, icon }) → the tag that was made, or null (the sheet shows why)
 * done      Save what is ticked. close: leave without saving.
 */
export default function TagDialog({ list, picked, setPicked, create, done, close, saving, error, clearError }) {
  const box = useRef(null)
  const [q, setQ] = useState('')
  const [making, setMaking] = useState(false)
  const [name, setName] = useState('')
  const [group, setGroup] = useState('') // never picked for them
  const [emoji, setEmoji] = useState('')
  const [made, setMade] = useState(null) // the tag just created
  const groups = groupsForScreen('network')

  // Focus stays inside the box; the phone keyboard does not cover it.
  useEffect(() => {
    const el = box.current
    if (!el) return undefined
    const before = document.activeElement
    el.focus({ preventScroll: true })
    const key = (e) => {
      if (e.key !== 'Tab') return
      const items = Array.from(el.querySelectorAll(FOCUSABLE))
      const first = items[0]; const last = items[items.length - 1]
      if (!first) { e.preventDefault(); return }
      if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', key)
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    const fit = () => el.style.setProperty('--td-vh', `${vv.height}px`)
    if (vv) { fit(); vv.addEventListener('resize', fit) }
    return () => {
      document.removeEventListener('keydown', key)
      if (vv) vv.removeEventListener('resize', fit)
      if (before && typeof before.focus === 'function') before.focus({ preventScroll: true })
    }
  }, [])

  const rows = list?.rows || []
  const count = ownTagCount(rows)
  const atLimit = count >= TAG_LIMIT_PER_LOCATION
  const countWords = `${count} / ${TAG_LIMIT_PER_LOCATION} location tags`
  const term = q.trim().toLowerCase()
  const typed = name.trim()
  const duplicate = !!typed && rows.some((t) => String(t.label).trim().toLowerCase() === typed.toLowerCase())
  const ready = !!typed && !!group && !duplicate
  // Search-to-create: something is typed and no tag has exactly that name.
  const exact = !!term && rows.some((t) => String(t.label).trim().toLowerCase() === term)
  const canMake = !!list?.sections && !!term && !exact

  // The eight Network groups, always, in their order; then anything else the
  // list holds (tags with no group yet, tags carried from another list).
  const stored = list?.sections || []
  const sections = [
    ...groups.map((g) => ({ key: g.key, label: g.label, hint: '', always: true, rows: stored.find((s) => s.key === g.key)?.rows || [] })),
    ...stored.filter((s) => !groups.some((g) => g.key === s.key)).map((s) => ({ ...s, always: false })),
  ].map((s) => ({ ...s, rows: s.rows.filter((t) => String(t.label).toLowerCase().includes(term)) }))
    .filter((s) => s.rows.length > 0 || (s.always && !term))
  const toggle = (id) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id])

  const startMaking = () => { setName(q.trim().slice(0, 60)); setGroup(''); setEmoji(''); setMade(null); clearError(); setMaking(true) }
  const backToList = () => { clearError(); setMaking(false) }
  const submitNew = async (e) => {
    e.preventDefault()
    if (!ready || saving) return
    const tag = await create({ label: typed, group, icon: newTagEmoji(group, emoji) })
    if (!tag) return
    setMade(tag); setQ(''); setMaking(false)
  }

  return (
    <div className="td-back" data-tag-dialog>
      <section ref={box} className="td" role="dialog" aria-modal="true" aria-labelledby="td-title" tabIndex={-1}>
        <header className="td-head">
          {making
            ? <button type="button" className="td-icon" aria-label="Back to tags" title="Back to tags" onClick={backToList} disabled={saving} data-create-back><Icon><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></Icon></button>
            : <TagsIcon />}
          <h2 id="td-title">{making ? 'Create a new tag' : 'Tags'}</h2>
          <button type="button" className="td-icon" aria-label="Close tags" title="Close" onClick={close} disabled={saving} data-cancel><Icon><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Icon></button>
        </header>

        {making ? (
          <form onSubmit={submitNew} data-form="new-tag">
            <div className="td-make">
              <label>Tag name
                <input autoFocus className="ns-input td-input" aria-label="Tag name" placeholder="Name your tag" maxLength={60} value={name} disabled={saving}
                  aria-invalid={error?.field === 'newTag' || undefined} onChange={(e) => { setName(e.target.value); clearError() }} data-field="newTag" />
              </label>
              {duplicate && <p role="status" className="td-line" style={{ marginTop: '-12px' }} data-tag-duplicate>A tag with this name already exists.</p>}
              <fieldset>
                <legend>Choose a group <b>· required</b></legend>
                <div className="td-chips" role="radiogroup" aria-label="Tag group" data-field="newGroup" aria-invalid={error?.field === 'newGroup' || undefined}>
                  {groups.map((g) => (
                    <button key={g.key} type="button" role="radio" aria-checked={group === g.key} className="td-choice" disabled={saving} onClick={() => { setGroup(g.key); clearError() }} data-group={g.key}>
                      <span aria-hidden="true">{g.emoji}</span>{g.label}{group === g.key && <CheckIcon size={16} />}
                    </button>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>Choose an emoji <b>· optional</b></legend>
                <div className="td-emojirow">
                  <span className="td-preview" aria-hidden="true" data-emoji-preview>{emoji || groupEmoji(group) || '🏷️'}</span>
                  <input className="ns-input" aria-label="Type any emoji" placeholder="Tap one below, or type any emoji" value={emoji} disabled={saving} onChange={(e) => setEmoji(firstEmoji(e.target.value) || '')} data-field="newEmoji" />
                </div>
                <div className="td-emojis" role="radiogroup" aria-label="Tag emoji" data-emoji-grid>
                  {NEW_TAG_EMOJI_GROUPS.map(([heading, choices]) => (
                    <div key={heading}>
                      <p>{heading}</p>
                      <div className="td-egrid">
                        {choices.map((c) => (
                          <button key={c} type="button" role="radio" aria-checked={emoji === c} aria-label={`Emoji ${c}`} className="td-echoice" disabled={saving} onClick={() => setEmoji(emoji === c ? '' : c)} data-emoji={c}>{c}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </fieldset>
              {error && <p role="alert" className="td-line" style={{ marginTop: 0 }} data-save-error>{error.words}</p>}
            </div>
            <footer className="td-foot" style={{ gap: '12px' }}>
              <span className="td-count" data-own-count>{countWords}</span>
              <button type="button" className="ns-btn ns-btn-ghost" onClick={backToList} disabled={saving} data-create-cancel>Cancel</button>
              <button type="submit" className="ns-btn ns-btn-primary" disabled={!ready || saving} data-create-tag>Create</button>
            </footer>
          </form>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); if (!saving && list?.sections) done() }} data-form="tags">
            <div className="td-top">
              <input type="search" className="ns-input td-input" aria-label="Search tags or type a new one" enterKeyHint="search" placeholder="Search tags or type a new one…" value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key !== 'Enter' || e.nativeEvent?.isComposing) return; e.preventDefault(); if (canMake && !atLimit && !saving) startMaking() }} data-field="tagSearch" />
              {list?.sections && <p className="td-small" data-own-count>{countWords}</p>}
              {list?.sections && atLimit && <p role="status" className="td-line" data-tag-limit>{tagLimitWords(count)}</p>}
              {made && <p role="status" className="td-line" data-tone="good" data-tag-note>{made.existing ? `“${made.label}” is already a tag, so it is ticked for you.` : `${tagEmoji(made)} ${made.label} created and selected.`}</p>}
              {!list && <p className="td-line" data-tags-loading>Loading Bee Hub&rsquo;s tags…</p>}
              {list?.problem && <p role="alert" className="td-line" data-tags-problem>The tag list could not be loaded. Nothing has been changed.</p>}
              {error && <p role="alert" className="td-line" data-save-error>{error.words}</p>}
            </div>
            <div className="td-list">
              {canMake && (
                <button type="button" className="td-create" onClick={startMaking} disabled={saving || atLimit} data-new-tag>
                  <Icon size={16}><path d="M5 12h14" /><path d="M12 5v14" /></Icon><span className="td-label">Create &ldquo;{q.trim()}&rdquo;</span>
                </button>
              )}
              {sections.map((s) => (
                <section key={s.key} className="td-section" aria-label={s.label} data-tag-section={s.key}>
                  <h3>{s.label}{!s.always && s.hint ? <i>{s.hint}</i> : null}</h3>
                  <div className="td-chips">
                    {s.rows.map((t) => {
                      const on = picked.includes(t.id)
                      return (
                        <button type="button" key={t.id} role="checkbox" aria-checked={on} aria-label={t.label} className="td-choice" disabled={saving} onClick={() => toggle(t.id)} data-pick-tag={t.id}>
                          <span aria-hidden="true" className="td-emoji">{tagEmoji(t)}</span><span className="td-label">{t.label}</span>
                          <span className="td-check" aria-hidden="true">{on && <CheckIcon />}</span>
                        </button>
                      )
                    })}
                  </div>
                  {!s.rows.length && <p className="td-none">No tags yet</p>}
                </section>
              ))}
              {list?.sections && term && sections.length === 0 && <p className="td-nomatch" data-no-match>No tags match.</p>}
            </div>
            <footer className="td-foot">
              <span className="td-count" data-picked-count>{picked.length} selected</span>
              {picked.length > 0 && <button type="button" className="ns-btn ns-btn-ghost" onClick={() => setPicked([])} disabled={saving} data-clear-tags>Clear all</button>}
              <button type="submit" className="ns-btn ns-btn-primary" disabled={saving || !list?.sections} aria-busy={saving || undefined} data-save>{saving ? 'Saving…' : 'Done'}</button>
            </footer>
          </form>
        )}
      </section>
    </div>
  )
}
