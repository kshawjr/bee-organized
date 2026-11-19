'use client'

// ADD A CONTACT (Network & Nurture redesign, slice 5).
//
// The Lovable design's AddWizard (brief-and-current, AddWizard.tsx, 356
// lines, five steps) CUT DOWN ON PURPOSE to one form holding only what the
// slice asks for: the types, name, company, job title, phone, email, where
// you met, birthday with its reminder, tags, and the location it lands in.
// Left out of the design's wizard, each on purpose (the brief names them):
//   · the business card reader (ScanCardButton): Kevin deferred it
//   · partner level and stage, and their confirmation (PartnerChoicePicker):
//     slice 6. A Referral partner added here starts as Potential, New Contact
//   · consent and Mailchimp (ConsentForm): waiting on Kevin's decision
//   · drips, workflows, the follow-up step and its confirmation
//   · the person / company switch: Organization is one of the five types
//   · "People at this company", the success card, "Add another"
// INTEREST (added 2026-11-18): Bee Hub has no column for it, so it is kept
// as the contact's first note, the same way an import keeps it.
//
// A DUPLICATE EMAIL (the Blaire Brimer ticket): the server refuses an email
// already on a live contact at this location, compared lowercased and
// trimmed on both sides, and names who. The box then shows that contact by
// name with three ways on, and the person picks one on purpose:
//   · change the email (the warning goes the moment the email changes)
//   · open the contact found (the host opens their sheet; this box closes)
//   · tick "Add anyway: a different person who shares this email", which
//     holds only for that exact email, then press Add contact again
// WITH NO EMAIL (2026-11-18) the server uses the import's other two rules:
// the same name and phone, or the same name with no phone on either side.
// The same box, naming who and which rule, with the same three ways (add an
// email or change the phone, open them, or add anyway). The warning and the
// tick belong to the exact name, phone and email they were about.
// NAMES (2026-11-19, Kevin: universal with Clients). A person gets two
// boxes, First and Last, and the full name is set from them the way Clients
// does (lib/network/names.ts). An organization gets one name box: a chamber
// of commerce has no last name. The form switches on the type picked, and
// carries what was typed across the switch. A joint name ("Drew & Bill" /
// "Crowley") is kept exactly as typed.
// After a save the box closes and the new contact opens in the contact
// sheet that already exists (the host does that, with the id).
//
// LOCATION: the one the list is looking at, shown at the top and not
// changeable here. The list only offers Add inside one location.
//
// TAGS: the same tag box as the contact sheet (TagDialog), on the Network
// groups only. A tag made here needs a group (Create stays off without one,
// and the server refuses one too), counts toward the location's ten, and
// exists from the moment Create is pressed, as it does on the sheet; the
// contact gets it when Add contact is pressed.
//
// It writes through two addresses and nothing else:
//   POST /api/network/contacts   the contact and its tags, all or nothing
//   POST /api/lookups            a new tag, only when one is made
//
// Fonts: it is only ever drawn inside the Network list, which asks for
// them itself, so this file makes no font request of its own.
//
// It closes by its own ✕, Cancel or Escape, never by a tap outside.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { T, NET, TAG_TONES } from '@/components/design/tokens'
import { NET_TYPES, TYPE_META, normalizeTypes } from '@/lib/network/types'
import { saveErrorWords } from '@/lib/network/contact-edit'
import { ADD_ERROR_WORDS } from '@/lib/network/contact-create'
import { tagEmoji } from '@/lib/network/contact-adds'
import { MAX_TAGS_PER_CREATE, TAG_GROUP_NEEDED_WORDS, groupTags, tagLimitWords } from '@/lib/tags'
import TagDialog, { TAG_DIALOG_CSS, TagsIcon } from './TagDialog'
import { SHEET_CSS } from './ContactSheet'
import { tagTone } from './NetworkListScreen'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const TYPE_COLOR = { partner: NET.partner, vendor: NET.vendor, nurture: NET.nurture, organization: NET.organization, unsure: NET.unsure }
const TAGS_SHOWN = 3
const NOT_SAVED = 'That did not save. Nothing was changed. Check the connection and try again.'

const S = '[data-network-add]'
const CSS = `
${S} .na-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
${S} .na-head h2{margin:4px 0 0;font-family:inherit;font-size:24px;font-weight:300;line-height:1.25;color:${T.primary}}
${S} .na-where{margin:6px 0 0;font-size:13px;color:${T.mutedFg}}
${S} .na-where b{color:${T.primary};font-weight:700}
${S} .na-types{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
${S} .na-type{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-height:64px;padding:10px 12px!important;border-radius:12px;border:1px solid ${T.input}!important;background:${T.card};text-align:left;color:${T.primary}}
${S} .na-type b{display:flex;align-items:center;gap:7px;font-size:13.5px;font-weight:700}
${S} .na-type b i{width:8px;height:8px;border-radius:999px;flex-shrink:0}
${S} .na-type small{font-size:12px;line-height:1.35;color:${T.mutedFg}}
${S} .na-type[aria-pressed="true"]{border-color:${T.primary}!important;box-shadow:0 0 0 1px ${T.primary};background:color-mix(in oklab,${T.primary} 6%,${T.card})}
${S} .na-req{color:${NET.accentFg};margin-left:2px}
${S} .na-hint{margin:0;padding:8px 12px;border-radius:8px;background:${T.goldSoft};font-size:12.5px;color:${NET.accentFg}}
${S} .na-foot{position:sticky;bottom:0;display:flex;justify-content:flex-end;gap:8px;padding:12px 24px calc(12px + env(safe-area-inset-bottom,0px));border-top:1px solid ${T.border};background:${T.card}}
${S} .na-legend{margin:0 0 8px;padding:0;font-size:12px;color:${T.mutedFg}}
${S} fieldset{margin:0;padding:0;border:0;min-width:0}
${S} .na-dup{display:grid;gap:8px;justify-items:start;padding:12px 14px;border-radius:12px;background:${NET.warnSoft};border:1px solid ${NET.warn};font-size:13.5px;color:${T.primary}}
${S} .na-dup p{margin:0}
${S} .na-dup .na-dup-ways{font-size:12.5px;color:${T.mutedFg}}
@media (max-width:600px){ ${S} .na-pair{grid-template-columns:1fr} }
`

const EMPTY = { name: '', firstName: '', lastName: '', types: [], company: '', title: '', phone: '', email: '', howWeMet: '', interest: '', month: '', day: '', birthdayReminder: false, tagIds: [] }
const emailKey = (v) => String(v ?? '').trim().toLowerCase()
const tidy = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const isOrgForm = (f) => f.types.includes('organization')
/** The full name as it will be stored: an organization's one box, or First + Last (lib/lead-name.ts's rule). */
export const fullNameOf = (f) => isOrgForm(f) ? tidy(f.name) : [tidy(f.firstName), tidy(f.lastName)].filter(Boolean).join(' ')
/** What a duplicate warning was about: the email, or with none the full name and phone's digits. */
const dupKey = (f) => emailKey(f.email) ? `e:${emailKey(f.email)}` : `n:${fullNameOf(f).toLowerCase()}|${String(f.phone ?? '').replace(/\D/g, '')}`
const DUP_RULE = { email_already_here: 'email', name_and_phone_already_here: 'name_phone', name_already_here: 'name_only' }
const DUP_WORDS = {
  email: { has: 'already has this email', ways: 'Change the email above', tick: 'a different person who shares this email' },
  name_phone: { has: 'already has this name and phone, and you gave no email', ways: 'Add an email or change the phone above', tick: 'a different person with the same name and phone' },
  name_only: { has: 'already has this name, and neither of you has a phone', ways: 'Add an email or a phone above', tick: 'a different person with the same name' },
}
const IconX = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>

/** One name into the two boxes: first word / the rest; a joint name stays whole in First. */
function splitForBoxes(name) {
  const n = tidy(name)
  if (!n) return {}
  if (/[&+/]|(^|\s)and(\s|$)/i.test(n) || !n.includes(' ')) return { firstName: n, lastName: '' }
  const i = n.indexOf(' ')
  return { firstName: n.slice(0, i), lastName: n.slice(i + 1) }
}

/** The words for a refusal from the add route, beside the field it names. */
export function addErrorWords(error) {
  return ADD_ERROR_WORDS[error] || saveErrorWords(error)
}

/**
 * Props
 *   locationId, locationName   where the contact goes (required)
 *   onClose()                  leave without saving
 *   onAdded(id)                after a save: the host opens the sheet
 *   onOpenExisting(id)         open the contact a duplicate email matched
 *   fetchImpl                  for tests
 */
export default function AddContactDialog({ locationId, locationName = '', onClose, onAdded, onOpenExisting = null, fetchImpl = null }) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null)
  const [f, setF] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null) // { field, words }
  const [tagList, setTagList] = useState(null) // null | { problem } | { rows, own, sections }
  const [tagsOpen, setTagsOpen] = useState(null) // the picked ids when the box opened, to undo on ✕
  const [dup, setDup] = useState(null) // { id, name, rule, key } the server matched
  const [addAnyway, setAddAnyway] = useState(false)
  const panel = useRef(null)

  const put = (k, v) => { setF((x) => ({ ...x, [k]: v })); if (error?.field === k) setError(null) }
  // The warning, and any "add anyway", belong to what they were about.
  const dupShown = dup && dupKey(f) === dup.key ? dup : null
  const isOrg = isOrgForm(f)
  const fullName = fullNameOf(f)
  const call = async (url, body) => {
    const res = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { res, json: await res.json().catch(() => ({})) }
  }

  // This location's tag list, shown in the Network groups only.
  const tagListOf = (rows, own) => ({ rows, own, sections: groupTags(rows, 'network', own) })
  useEffect(() => {
    let alive = true
    doFetch(`/api/lookups?category=tags&location_id=${encodeURIComponent(locationId)}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (!res.ok || !Array.isArray(json.lookups)) throw new Error('tags')
        if (alive) setTagList(tagListOf(json.lookups.filter((t) => t.is_active !== false), json.location?.name ? `${json.location.name}’s own` : null))
      })
      .catch(() => { if (alive) setTagList({ problem: true }) })
    return () => { alive = false }
  }, [locationId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Escape leaves (the tag box handles its own first). Focus starts inside.
  useEffect(() => {
    panel.current?.focus({ preventScroll: true })
    const key = (e) => { if (e.key === 'Escape' && !saving && tagsOpen === null) onClose() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [saving, tagsOpen, onClose])

  const shownTags = useMemo(() => {
    const all = (tagList?.sections || []).flatMap((s) => s.rows)
    return f.tagIds.map((id) => all.find((t) => t.id === id)).filter(Boolean)
  }, [tagList, f.tagIds])

  const flipType = (t) => {
    const next = f.types.includes(t) ? f.types.filter((x) => x !== t) : [...f.types, t]
    // "Not sure yet" means nothing is decided: it gives way to any real type.
    const clean = t === 'unsure' && !f.types.includes('unsure') ? ['unsure'] : next.filter((x) => x !== 'unsure' || next.length === 1)
    setF((x) => {
      const wasOrg = x.types.includes('organization')
      const nowOrg = clean.includes('organization')
      // What was typed follows the switch: First + Last become the one name,
      // and the one name becomes First (first word) and Last (the rest).
      const carry = nowOrg && !wasOrg && !tidy(x.name) ? { name: fullNameOf(x) }
        : !nowOrg && wasOrg && !tidy(x.firstName) && !tidy(x.lastName) ? splitForBoxes(x.name) : {}
      return { ...x, ...carry, types: clean, ...(nowOrg ? { month: '', day: '', birthdayReminder: false } : {}) }
    })
    if (error?.field === 'types') setError(null)
  }

  // A NEW TAG from the tag box: this location's own, in the group the person
  // picks (never assumed), counted toward the ten. The same request the
  // contact sheet makes. Answers the tag, or null with the reason shown.
  async function createTag({ label, group, icon }) {
    if (!label || saving || !tagList?.rows) return null
    if (!group) { setError({ field: 'newGroup', words: TAG_GROUP_NEEDED_WORDS }); return null }
    setSaving(true); setError(null)
    try {
      const { res, json } = await call('/api/lookups', { category: 'tags', label, location_id: locationId, made_on: 'network', group, icon })
      if (res.status === 409 && json?.error === 'tag_limit') { setError({ field: 'newTag', words: tagLimitWords(Number(json.count) || 0) }); return null }
      if (res.status === 409 && json?.error === 'near_match' && json.tag) {
        const there = tagList.sections.flatMap((s) => s.rows).find((t) => t.id === json.tag.id)
        if (there) { setF((x) => ({ ...x, tagIds: x.tagIds.includes(there.id) ? x.tagIds : [...x.tagIds, there.id] })); return { ...there, existing: true } }
        setError({ field: 'newTag', words: json.verdict === 'restore' ? `“${json.tag.label}” was removed at this location. Bring it back under Settings rather than making it again.` : `“${json.tag.label}” is already a tag on another list, so it is not offered here.` })
        return null
      }
      if (res.status === 400 && json?.error === 'group_required') { setError({ field: 'newGroup', words: TAG_GROUP_NEEDED_WORDS }); return null }
      if (!res.ok || !json?.lookup) { setError({ field: 'newTag', words: 'That tag could not be created. Nothing was changed.' }); return null }
      setTagList(tagListOf([...tagList.rows, json.lookup], tagList.own))
      setF((x) => ({ ...x, tagIds: [...x.tagIds, json.lookup.id] }))
      return json.lookup
    } catch {
      setError({ field: 'newTag', words: NOT_SAVED })
      return null
    } finally {
      setSaving(false)
    }
  }

  const birthday = f.month && f.day ? `${f.month} ${f.day}` : ''
  const ready = fullName && f.types.length > 0

  async function save() {
    if (saving) return
    if (!f.types.length) { setError({ field: 'types', words: addErrorWords('types_required') }); return }
    if (!fullName) { setError({ field: isOrg ? 'name' : 'firstName', words: addErrorWords(isOrg ? 'name_required' : 'person_name_required') }); return }
    if (f.month && !f.day) { setError({ field: 'birthday', words: addErrorWords('birthday_unreadable') }); return }
    // Enter in a field submits even with the button off: the warning holds here too.
    if (dupShown && !addAnyway) return
    setSaving(true); setError(null)
    try {
      const { res, json } = await call('/api/network/contacts', {
        location_id: locationId, ...(isOrg ? { name: f.name } : { firstName: f.firstName, lastName: f.lastName }), types: normalizeTypes(f.types), company: f.company, title: f.title,
        phone: f.phone, email: f.email, howWeMet: f.howWeMet, interest: f.interest, birthday, birthdayReminder: !!(birthday && f.birthdayReminder), tagIds: f.tagIds,
        ...(dupShown && addAnyway ? { addAnyway: true } : {}),
      })
      if (res.status === 201 && json?.id) { onAdded(json.id); return }
      if (res.status === 409 && DUP_RULE[json?.error] && json.matched?.id) {
        setDup({ id: json.matched.id, name: json.matched.name || 'Unnamed', rule: DUP_RULE[json.error], key: dupKey(f) }); setAddAnyway(false)
        return
      }
      setError({ field: json?.field || 'form', words: json?.error ? addErrorWords(json.error) : NOT_SAVED })
    } catch {
      setError({ field: 'form', words: NOT_SAVED })
    } finally {
      setSaving(false)
    }
  }

  const fieldError = (k) => (error?.field === k ? <p className="ns-error" role="alert" data-error={k}>{error.words}</p> : null)
  const input = (k, label, props = {}) => (
    // Label and asterisk in ONE piece: .ns-field is a grid, so a loose star
    // sat on a line of its own (seen in the 1280 and 390 screenshots).
    <label className="ns-field"><span>{label}{props.required && <span className="na-req" aria-hidden="true">*</span>}</span>
      <input className="ns-input" value={f[k]} onChange={(e) => put(k, e.target.value)} disabled={saving} aria-invalid={error?.field === k || undefined} data-field={k} {...props} />
      {fieldError(k)}
    </label>
  )

  return (
    <div data-network-sheet data-network-add role="presentation">
      <style>{SHEET_CSS + TAG_DIALOG_CSS + CSS}</style>
      <aside className="ns-sheet" role="dialog" aria-modal="true" aria-label="Add a contact" tabIndex={-1} ref={panel}>
        <div className="ns-top">
          <p className="ns-eyebrow">Add to Network</p>
          <button type="button" className="ns-close" onClick={onClose} disabled={saving} aria-label="Close without adding" title="Close"><IconX /></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); save() }} data-add-form>
          <div className="ns-body">
            <div className="na-head">
              <div>
                <h2>Who are you adding?</h2>
                <p className="na-where" data-lands-in>Goes into <b>{locationName || 'this location'}</b></p>
              </div>
            </div>

            <fieldset data-types>
              <legend className="na-legend">What are they to you? Pick one or more.<span className="na-req" aria-hidden="true">*</span></legend>
              <div className="na-types">
                {NET_TYPES.map((t) => (
                  <button key={t} type="button" className="na-type" aria-pressed={f.types.includes(t)} onClick={() => flipType(t)} disabled={saving} data-type={t}>
                    <b><i style={{ background: TYPE_COLOR[t] }} />{TYPE_META[t].label}</b>
                    <small>{TYPE_META[t].blurb}</small>
                  </button>
                ))}
              </div>
              {fieldError('types')}
            </fieldset>

            <div className="ns-form">
              {isOrg ? input('name', 'Organization name', { required: true, autoComplete: 'off', maxLength: 200 }) : (
                <div className="ns-two na-pair" data-person-name>
                  {input('firstName', 'First name', { required: true, autoComplete: 'off', maxLength: 200 })}
                  {input('lastName', 'Last name', { autoComplete: 'off', maxLength: 200 })}
                </div>
              )}
              <div className="ns-two na-pair">
                {input('company', 'Company')}
                {input('title', 'Job title')}
              </div>
              <div className="ns-two na-pair">
                {input('phone', 'Phone', { inputMode: 'tel', autoComplete: 'off' })}
                {input('email', 'Email', { inputMode: 'email', autoComplete: 'off' })}
              </div>
              {dupShown && (
                <div className="na-dup" role="alert" data-duplicate={dupShown.id} data-rule={dupShown.rule}>
                  <p><b>{dupShown.name}</b> at {locationName || 'this location'} {DUP_WORDS[dupShown.rule].has}. Nothing was added.</p>
                  <p className="na-dup-ways">{DUP_WORDS[dupShown.rule].ways}, open {dupShown.name.split(/\s+/)[0]} instead, or tick the box if this really is someone else.</p>
                  {onOpenExisting && <button type="button" className="ns-btn ns-btn-ghost" onClick={() => onOpenExisting(dupShown.id)} disabled={saving} data-open-existing>Open {dupShown.name}</button>}
                  <label className="ns-check">
                    <input type="checkbox" checked={addAnyway} disabled={saving} onChange={(e) => setAddAnyway(e.target.checked)} data-add-anyway />
                    Add anyway: {DUP_WORDS[dupShown.rule].tick}
                  </label>
                </div>
              )}
              {!f.phone.trim() && !f.email.trim() && fullName && (
                <p className="na-hint" data-reach-hint>A phone or email lets you actually reach {isOrg ? fullName : fullName.split(' ')[0]}. You can still add them without one.</p>
              )}
              {input('howWeMet', 'Where did you meet?', { placeholder: 'e.g. Chamber breakfast, a client’s designer' })}
              {input('interest', 'Interest', { placeholder: 'e.g. Garage, a move in the spring', maxLength: 500 })}
              {!isOrg && (
                <div className="ns-field" data-birthday>Birthday (month and day)
                  <div className="ns-two">
                    <select className="ns-input" aria-label="Birthday month" value={f.month} disabled={saving} aria-invalid={error?.field === 'birthday' || undefined}
                      onChange={(e) => setF((x) => ({ ...x, month: e.target.value, day: e.target.value ? x.day : '', birthdayReminder: e.target.value ? x.birthdayReminder : false }))} data-field="month">
                      <option value="">No birthday</option>
                      {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <select className="ns-input" aria-label="Birthday day" value={f.day} disabled={saving || !f.month} onChange={(e) => put('day', e.target.value)} data-field="day">
                      <option value="">Day</option>
                      {Array.from({ length: f.month ? DAYS_IN[MONTHS.indexOf(f.month)] : 31 }, (_, i) => <option key={i + 1} value={String(i + 1)}>{i + 1}</option>)}
                    </select>
                  </div>
                  <label className="ns-check">
                    <input type="checkbox" checked={f.birthdayReminder && !!birthday} disabled={saving || !birthday} onChange={(e) => put('birthdayReminder', e.target.checked)} data-field="birthdayReminder" />
                    Mark for a birthday reminder
                  </label>
                  {fieldError('birthday')}{fieldError('birthdayReminder')}
                </div>
              )}

              <div aria-label="Tags" data-add-tags>
                <button type="button" className="td-trigger" aria-haspopup="dialog" data-has={f.tagIds.length > 0}
                  disabled={saving || !tagList || tagList.problem} onClick={() => { setError(null); setTagsOpen(f.tagIds) }} data-open-tags>
                  <span className="td-tlabel"><TagsIcon size={16} />Tags</span>
                  <span className="td-tchips">
                    {tagList?.problem ? <span data-tags-problem>Tags could not be loaded; add them from the sheet afterwards</span>
                      : !tagList ? <span>Loading tags…</span>
                      : shownTags.length === 0 ? <span data-no-tags>Add tags</span>
                      : shownTags.slice(0, TAGS_SHOWN).map((t) => { const tone = TAG_TONES[tagTone(t.label)]; return <span key={t.id} className="ns-chip" data-tag={t.id} style={{ color: tone.fg, background: tone.bg, borderColor: tone.border }}><span aria-hidden="true" className="ns-emoji">{tagEmoji(t)}</span>{t.label}</span> })}
                    {shownTags.length > TAGS_SHOWN && <span className="ns-chip td-more">+{shownTags.length - TAGS_SHOWN} more</span>}
                  </span>
                </button>
                {fieldError('tagIds')}
              </div>
              {error?.field === 'form' || error?.field === 'location' ? <p className="ns-error" role="alert" data-error="form">{error.words}</p> : null}
            </div>
          </div>
          <div className="na-foot">
            <button type="button" className="ns-btn ns-btn-ghost" onClick={onClose} disabled={saving} data-cancel>Cancel</button>
            <button type="submit" className="ns-btn ns-btn-primary" disabled={saving || !ready || (!!dupShown && !addAnyway)} data-save>{saving ? 'Adding…' : 'Add contact'}</button>
          </div>
        </form>
      </aside>
      {tagsOpen !== null && tagList?.rows && (
        <TagDialog list={tagList} picked={f.tagIds}
          setPicked={(ids) => setF((x) => ({ ...x, tagIds: ids.slice(0, MAX_TAGS_PER_CREATE) }))}
          create={createTag}
          done={() => { setTagsOpen(null); setError(null) }}
          close={() => { setF((x) => ({ ...x, tagIds: tagsOpen })); setTagsOpen(null); setError(null) }}
          saving={saving} error={error} clearError={() => setError(null)} />
      )}
    </div>
  )
}
