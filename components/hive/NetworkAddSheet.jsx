// components/hive/NetworkAddSheet.jsx
// ─────────────────────────────────────────────────────────────
// ONE Add entry for Network — Person / Company behind a SEGMENTED TOGGLE
// (deliberately not a wizard step: the shared fields — name-ish, phone,
// email, website, address — SURVIVE a toggle flip; a step-based chooser
// makes switching restart the form, which is exactly how fields get
// lost). Replaces the Classic AddPartnerModal + AddCompanyModal pair,
// both retained-unrendered in BeeHub for the retired Classic callers.
//
// Beta shell throughout (the NewClientSheet standard): OverlayShell,
// formKit inp/lbl (16px inputs — iOS-zoom rule, load-bearing),
// required-ness in the label, danger.soft inline error strip, full-width
// primary/secondary buttons in the body flow, tokens only.
//
// FIXES TWO LIVE FIELD-LOSS BUGS the Classic modal shipped with:
//   0a. TITLE — collected and then dropped from the emitted object.
//       Emitted as `title` here (the partnerPatchToRow camelCase key,
//       so it lands in the DB column, pinned by test).
//   0b. THE COMPANY DISPLAY STRING — person-create wrote company_id but
//       never `company`, so the Network list (which reads the string)
//       showed a blank subtitle. Both keys are written now, matching
//       what link-people always did.
//   0c. stage — every new row starts 'New Contact' (the Classic contact
//       branch hardcoded 'Contact', a value outside the stage
//       vocabulary that rendered beside an unfilled pipeline rail).
//
// The partner/contact TYPE SPLIT stays dead (Phase 2): rows emit
// type:'partner'; `relationship` survives as an optional person field.
//
// §8.5: props only — the picklists (admin specialties/tiers) and the
// live partner/company pools come from the host; creates go UP through
// onAddPerson/onAddCompany (the context's server-first creators).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useMemo, useState } from 'react'
import OverlayShell from './OverlayShell'
import useIsMobile from './shared/useIsMobile'
import AddressAutofill from './shared/AddressAutofill'
import { T } from './shared/tokens'
import { inp, lbl } from './shared/formKit'

const primaryBtn = (enabled) => ({
  width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
  padding: '10px 14px', borderRadius: T.radius.control, border: 'none',
  background: enabled ? T.accent.fg : T.surface.sunken,
  color: enabled ? T.accent.onFill : T.ink.disabled,
  fontSize: '13px', fontWeight: 500, cursor: enabled ? 'pointer' : 'not-allowed',
  fontFamily: 'inherit', whiteSpace: 'nowrap',
})
const secondaryBtn = {
  width: '100%', padding: '10px 14px', borderRadius: T.radius.control,
  border: T.border.strong, background: 'transparent',
  fontSize: '13px', fontWeight: 500, color: T.ink.primary,
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
}

const RELATIONSHIPS = ['Neighbor', 'Realtor', 'Past Client', 'Friend', 'Family', 'Vendor', 'Other']

const pillBtn = (on) => ({
  padding: '5px 12px', borderRadius: T.radius.pill,
  border: `0.5px solid ${on ? T.hairline.strong : T.hairline.line}`,
  background: on ? T.accent.soft : T.surface.raised,
  fontSize: '12px', fontWeight: on ? 500 : 400,
  color: on ? T.accent.deep : T.ink.muted,
  cursor: 'pointer', fontFamily: 'inherit',
})

export default function NetworkAddSheet({
  onClose = () => {},
  onAddPerson = async () => null,     // client-shaped person → context addPartner (server-first)
  onAddCompany = async () => null,    // client-shaped company → context addCompany (server-first)
  onUpdatePartner = () => {},         // link-people writes (companyId + company string per person)
  partners = [],                      // live pool — link-people
  companies = [],                     // live pool — the person branch's company typeahead
  specialties = [],                   // admin list [{ id, label }]
  tiers = [],                         // admin list [{ id, label, desc? }]
  defaultCompany = null,              // { id, name } — company record's "+ Add person"; FORCES the Person position
}) {
  const isMobile = useIsMobile()
  // The preset means "create a person INTO this company" — Person wins.
  const [kind, setKind] = useState('person')          // 'person' | 'company'
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  // ── shared fields (SURVIVE the toggle — the whole point) ──
  const [shared, setShared] = useState({ phone: '', email: '', website: '', street: '', apt: '', city: '', state: '', zip: '' })
  const setS = (k, v) => setShared(f => ({ ...f, [k]: v }))
  const [showAddr, setShowAddr] = useState(false)

  // ── person fields ──
  const [person, setPerson] = useState({
    firstName: '', lastName: '', title: '', howWeMet: '', relationship: '',
    specialties: [], tier: null,
  })
  const setP = (k, v) => setPerson(f => ({ ...f, [k]: v }))
  const toggleSpec = (id) => setPerson(f => ({ ...f, specialties: f.specialties.includes(id) ? f.specialties.filter(x => x !== id) : [...f.specialties, id] }))

  // Company link (person branch): picked id + display name, or free text.
  const [companyPick, setCompanyPick] = useState(defaultCompany ? { id: defaultCompany.id, name: defaultCompany.name } : null)
  const [companyText, setCompanyText] = useState('')
  const [companyOpen, setCompanyOpen] = useState(false)
  const [companyCreating, setCompanyCreating] = useState(false)

  // ── company fields ──
  const [company, setCompany] = useState({ name: '', industry: '', notes: '' })
  const setC = (k, v) => setCompany(f => ({ ...f, [k]: v }))
  const [linkedIds, setLinkedIds] = useState([])
  const [peopleSearch, setPeopleSearch] = useState('')

  const livePartners = useMemo(() => partners.filter(p => !p.isDeleted), [partners])
  const liveCompanies = useMemo(() => companies.filter(c => !c.isDeleted), [companies])

  const canAdd = kind === 'person'
    ? !!(person.firstName.trim() && person.lastName.trim())
    : !!company.name.trim()

  const composeAddresses = () => {
    const streetWithApt = [shared.street, shared.apt].filter(Boolean).join(' ')
    const value = [streetWithApt, shared.city, shared.state, shared.zip].filter(Boolean).join(', ')
    return value
      ? [{ type: kind === 'person' ? 'Business' : 'Office', value, street: shared.street, apt: shared.apt, city: shared.city, state: shared.state, zip: shared.zip }]
      : []
  }

  async function submit() {
    if (!canAdd || busy) return
    setBusy(true); setErr(null)
    try {
      if (kind === 'person') {
        // 0a + 0b + 0c live here: title emitted; BOTH companyId and the
        // company display string; stage always 'New Contact'.
        const companyName = companyPick?.name || companyText.trim()
        await onAddPerson({
          type: 'partner',
          name: `${person.firstName.trim()} ${person.lastName.trim()}`.trim(),
          title: person.title,
          companyId: companyPick?.id || null,
          company: companyName || '',
          phone: shared.phone, email: shared.email, website: shared.website,
          addresses: composeAddresses(),
          stage: 'New Contact',
          specialties: person.specialties,
          tier: person.tier,
          relationship: person.relationship,
          howWeMet: person.howWeMet, metDate: 'Just now', lastContact: 'Just now',
          isCustomer: false, customerLeadId: null,
          tags: [], referrals: [], notes: [],
          activity: [{ type: 'event', label: `Added to Network${person.howWeMet ? ' - ' + person.howWeMet : ''}`, ts: 'Just now' }],
        })
      } else {
        const created = await onAddCompany({
          name: company.name.trim(),
          industry: company.industry,
          phone: shared.phone, email: shared.email, website: shared.website,
          addresses: composeAddresses(),
          notes: company.notes.trim()
            ? [{ id: `n${Date.now()}`, text: company.notes.trim(), ts: new Date().toISOString(), user: 'You' }]
            : [],
          activity: [{ type: 'event', label: 'Company created', ts: 'Just now' }],
        })
        // Link-people: BOTH keys per person — companyId (the FK, source of
        // truth) AND the company display string (the cache) — the pairing
        // the Classic link path always got right.
        if (created?.id) {
          for (const id of linkedIds) {
            const p = livePartners.find(x => x.id === id)
            if (p) onUpdatePartner({ ...p, companyId: created.id, company: created.name })
          }
        }
      }
      onClose()
    } catch (e) {
      setErr(String(e?.message || e) || 'Save failed — please try again')
    } finally {
      setBusy(false)
    }
  }

  // Inline name-only company create from the person branch's typeahead —
  // deliberately thin (naming an org mid-person-create shouldn't demand
  // its full details; the company record fills the rest).
  async function createCompanyInline() {
    const name = companyText.trim()
    if (!name || companyCreating) return
    setCompanyCreating(true)
    try {
      const real = await onAddCompany({ name, industry: '', phone: '', email: '', website: '', addresses: [], notes: [], activity: [{ type: 'event', label: 'Created inline', ts: 'Just now' }] })
      if (real?.id) setCompanyPick({ id: real.id, name: real.name })
      setCompanyOpen(false)
    } catch (e) {
      setErr(`Couldn't create company: ${String(e?.message || e)}`)
    } finally {
      setCompanyCreating(false)
    }
  }

  const companyMatches = useMemo(() => {
    const q = companyText.trim().toLowerCase()
    if (!q) return liveCompanies.slice(0, 6)
    return liveCompanies.filter(c => (c.name || '').toLowerCase().includes(q) || (c.industry || '').toLowerCase().includes(q))
  }, [companyText, liveCompanies])

  const filteredPeople = useMemo(() => {
    const q = peopleSearch.trim().toLowerCase()
    return livePartners.filter(p => !q || (p.name || '').toLowerCase().includes(q))
  }, [peopleSearch, livePartners])

  const addressBlock = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '13px', color: T.ink.secondary }}>Add address · optional</span>
        <button type="button" role="switch" aria-checked={showAddr} aria-label="Add address"
          onClick={() => setShowAddr(v => !v)}
          style={{ position: 'relative', width: '40px', height: '22px', borderRadius: '11px', border: 'none', cursor: 'pointer', background: showAddr ? T.accent.fg : T.hairline.line, transition: 'background 0.2s', flexShrink: 0, padding: 0 }}>
          <span style={{ position: 'absolute', top: '2px', left: showAddr ? '20px' : '2px', width: '18px', height: '18px', borderRadius: T.radius.round, background: T.surface.raised, transition: 'left 0.2s', boxShadow: T.shadow.knob }} />
        </button>
      </div>
      {showAddr && (
        <div style={{ display: 'grid', gap: '10px' }}>
          <div>
            <label style={lbl}>Street</label>
            <AddressAutofill
              value={shared.street}
              onChange={v => setS('street', v)}
              onParsed={({ street, apt, city, state, zip }) => setShared(f => ({ ...f, street, apt: apt || f.apt, city, state, zip }))}
              style={inp}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div><label style={lbl}>Apt / Suite · optional</label><input style={inp} value={shared.apt} onChange={e => setS('apt', e.target.value)} aria-label="Apt" /></div>
            <div><label style={lbl}>City</label><input style={inp} value={shared.city} onChange={e => setS('city', e.target.value)} aria-label="City" /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div><label style={lbl}>State</label><input style={inp} value={shared.state} onChange={e => setS('state', e.target.value)} aria-label="State" /></div>
            <div><label style={lbl}>Zip</label><input style={inp} value={shared.zip} onChange={e => setS('zip', e.target.value)} aria-label="Zip" /></div>
          </div>
        </div>
      )}
    </>
  )

  const sharedContactBlock = (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <div><label style={lbl}>Phone · optional</label><input style={inp} type="tel" value={shared.phone} onChange={e => setS('phone', e.target.value)} aria-label="Phone" /></div>
        <div><label style={lbl}>Email · optional</label><input style={inp} type="email" value={shared.email} onChange={e => setS('email', e.target.value)} aria-label="Email" /></div>
      </div>
      <div><label style={lbl}>Website · optional</label><input style={inp} value={shared.website} onChange={e => setS('website', e.target.value)} aria-label="Website" /></div>
      {addressBlock}
    </>
  )

  return (
    <OverlayShell isMobile={isMobile} onClose={onClose}>
      <div style={{ padding: isMobile ? '0 16px 28px' : '0 24px 24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 500, color: T.ink.primary }}>Add to your network</h2>
          <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '4px' }}>
            {kind === 'person' ? 'A person who sends you work — or might.' : 'An organization you can link people to.'}
          </p>
        </div>

        {/* ── the segmented toggle — shared values survive a flip ── */}
        <div role="tablist" aria-label="What are you adding?" style={{ display: 'flex', background: T.surface.sunken, borderRadius: T.radius.control, padding: '3px' }}>
          {[['person', 'Person'], ['company', 'Company']].map(([v, label]) => (
            <button key={v} role="tab" aria-selected={kind === v} onClick={() => { setKind(v); setErr(null) }}
              style={{ flex: 1, padding: '8px 4px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '12px', fontFamily: 'inherit', fontWeight: kind === v ? 600 : 400, background: kind === v ? T.surface.raised : 'transparent', color: kind === v ? T.ink.primary : T.ink.muted, boxShadow: kind === v ? T.shadow.card : 'none' }}>
              {label}
            </button>
          ))}
        </div>

        {err && (
          <p style={{ fontSize: '12px', color: T.state.danger.fg, background: T.state.danger.soft, padding: '8px 12px', borderRadius: T.radius.control }}>{err}</p>
        )}

        {kind === 'person' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div><label style={lbl}>First name</label><input autoFocus style={inp} value={person.firstName} onChange={e => setP('firstName', e.target.value)} aria-label="First name" /></div>
              <div><label style={lbl}>Last name</label><input style={inp} value={person.lastName} onChange={e => setP('lastName', e.target.value)} aria-label="Last name" /></div>
            </div>

            {/* Company — pick / free-type / inline name-only create */}
            <div>
              <label style={lbl}>Company · optional</label>
              {companyPick ? (
                <div data-testid="company-chip" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 11px', border: T.border.strong, borderRadius: T.radius.control, background: T.accent.faint }}>
                  <span style={{ flex: 1, fontSize: '13px', fontWeight: 500, color: T.ink.primary }}>{companyPick.name}</span>
                  <button aria-label="Clear company" onClick={() => { setCompanyPick(null); setCompanyText('') }}
                    style={{ border: 'none', background: 'transparent', color: T.ink.quiet, cursor: 'pointer', fontSize: '15px', lineHeight: 1, padding: '2px' }}>×</button>
                </div>
              ) : (
                <div style={{ position: 'relative' }}>
                  <input style={inp} placeholder="Search or type a company name…" aria-label="Company"
                    value={companyText}
                    onChange={e => { setCompanyText(e.target.value); setCompanyOpen(true) }}
                    onFocus={() => setCompanyOpen(true)}
                    onBlur={() => setTimeout(() => setCompanyOpen(false), 150)} />
                  {companyOpen && (companyMatches.length > 0 || companyText.trim()) && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: T.surface.raised, borderRadius: T.radius.control, border: T.border.thin, boxShadow: T.shadow.pop, marginTop: '4px', overflow: 'hidden' }}>
                      {companyMatches.slice(0, 6).map(c => (
                        <button key={c.id} onMouseDown={() => { setCompanyPick({ id: c.id, name: c.name }); setCompanyOpen(false) }}
                          style={{ width: '100%', padding: '9px 12px', background: 'none', border: 'none', borderBottom: T.border.divider, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                          <p style={{ fontSize: '13px', fontWeight: 500, color: T.ink.primary }}>{c.name}</p>
                          {c.industry && <p style={{ fontSize: '11px', color: T.ink.muted }}>{c.industry}</p>}
                        </button>
                      ))}
                      {companyText.trim() && (
                        <button onMouseDown={createCompanyInline} disabled={companyCreating}
                          style={{ width: '100%', padding: '9px 12px', background: T.accent.faint, border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                          <p style={{ fontSize: '13px', fontWeight: 500, color: T.accent.deep }}>
                            {companyCreating ? 'Creating…' : `＋ Create “${companyText.trim()}”`}
                          </p>
                          <p style={{ fontSize: '11px', color: T.ink.muted }}>Name-only — fill the rest on its record</p>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div><label style={lbl}>Title / role · optional</label><input style={inp} placeholder="Real Estate Agent" value={person.title} onChange={e => setP('title', e.target.value)} aria-label="Title" /></div>

            {sharedContactBlock}

            <div><label style={lbl}>How / where you met · optional</label><input style={inp} placeholder="Denver Business Expo, referral from…" value={person.howWeMet} onChange={e => setP('howWeMet', e.target.value)} aria-label="How met" /></div>

            <div>
              <label style={lbl}>Relationship · optional</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {RELATIONSHIPS.map(r => (
                  <button key={r} onClick={() => setP('relationship', person.relationship === r ? '' : r)} style={pillBtn(person.relationship === r)}>{r}</button>
                ))}
              </div>
            </div>

            <div>
              <label style={lbl}>Specialty · optional, all that apply</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '150px', overflowY: 'auto', padding: '2px' }}>
                {specialties.map(s => (
                  <button key={s.id} data-spec={s.id} onClick={() => toggleSpec(s.id)} style={pillBtn(person.specialties.includes(s.id))}>{s.label}</button>
                ))}
              </div>
            </div>

            <div>
              <label style={lbl}>Partner tier · optional</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {tiers.map(t => (
                  <button key={t.id} data-tier={t.id} onClick={() => setP('tier', person.tier === t.id ? null : t.id)} style={pillBtn(person.tier === t.id)}>{t.label}</button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div><label style={lbl}>Company name</label><input autoFocus style={inp} placeholder="ABC Moving & Storage" value={company.name} onChange={e => setC('name', e.target.value)} aria-label="Company name" /></div>
            <div><label style={lbl}>Industry · optional</label><input style={inp} placeholder="Moving Services, Real Estate…" value={company.industry} onChange={e => setC('industry', e.target.value)} aria-label="Industry" /></div>

            {sharedContactBlock}

            <div>
              <label style={lbl}>Notes · optional</label>
              <textarea style={{ ...inp, resize: 'none', height: '60px' }} placeholder="Key things to remember about this company…" value={company.notes} onChange={e => setC('notes', e.target.value)} aria-label="Company notes" />
            </div>

            {livePartners.length > 0 && (
              <div data-testid="link-people">
                <label style={lbl}>Link people · optional</label>
                <input style={{ ...inp, marginBottom: '8px' }} placeholder="Search your network…" value={peopleSearch} onChange={e => setPeopleSearch(e.target.value)} aria-label="Search people to link" />
                <div style={{ maxHeight: '150px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {filteredPeople.slice(0, 20).map(p => {
                    const on = linkedIds.includes(p.id)
                    return (
                      <button key={p.id} data-link-person={p.id} aria-pressed={on}
                        onClick={() => setLinkedIds(prev => on ? prev.filter(x => x !== p.id) : [...prev, p.id])}
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', background: on ? T.accent.faint : T.surface.raised, border: on ? T.border.strong : T.border.thin, borderRadius: T.radius.control, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                        <span style={{ flex: 1, fontSize: '13px', fontWeight: on ? 500 : 400, color: T.ink.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                        {p.title && <span style={{ fontSize: '11px', color: T.ink.muted, flexShrink: 0 }}>{p.title}</span>}
                        {on && <span aria-hidden style={{ color: T.accent.deep, fontSize: '13px', flexShrink: 0 }}>✓</span>}
                      </button>
                    )
                  })}
                </div>
                {linkedIds.length > 0 && <p style={{ fontSize: '11px', color: T.ink.muted, marginTop: '5px' }}>{linkedIds.length} {linkedIds.length === 1 ? 'person' : 'people'} will be linked</p>}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
          <button style={primaryBtn(canAdd && !busy)} disabled={!canAdd || busy} onClick={submit}>
            {busy ? 'Adding…' : kind === 'person' ? 'Add person' : 'Add company'}
          </button>
          <button style={secondaryBtn} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </OverlayShell>
  )
}
