// components/hive/NetworkCompanyRecord.jsx
// ─────────────────────────────────────────────────────────────
// NETWORK — the company record (Phase 3). Retires the Classic inline
// company overlay. Beta-chunk (§8.5): props only, tokens only.
//
// A company's relationship IS its people's, rolled up:
//   PEOPLE HERE  — every live contact at the company (company_id FK, the
//                  source of truth), each with badges, referral count and
//                  last-talked (stale = danger). "+ Add person" creates
//                  INTO this company.
//   TOUCHPOINTS  — rolled up across everyone, each line naming WHO it was
//                  with (/api/companies/:id/touchpoints) — the history
//                  survives someone leaving because it belongs to people.
//   LEADS REFERRED — company-level total from /api/companies/:id/referrals:
//                  direct company referrals (referred_by_kind='company')
//                  AND via-person rows, each attributed "via <person>".
//   Last-talked derives from its people (companies have no touchpoint
//   subject of their own — deliberate Phase 1 scope).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useMemo, useState } from 'react'
import OverlayShell from './OverlayShell'
import useIsMobile from './shared/useIsMobile'
import InitialsAvatar from './shared/InitialsAvatar'
import RecordMenu from './shared/RecordMenu'
import { T } from './shared/tokens'
import { deriveNetworkBadges, BadgeChip, StatTile, SectionLabel, InlineText, fmtLastTalk } from './shared/networkKit'
import { contactRecency, stageFamilyKey } from './shared/networkGroups'

const money = (n) => `$${Math.round(n).toLocaleString()}`
const METHOD_LABEL = { call: 'Call', sms: 'Text', email: 'Email', in_person: 'In person', coffee: 'Coffee', event: 'Event', thank_you: 'Thank-you' }

export default function NetworkCompanyRecord({
  company,
  partners = [],            // full pool — filtered to this company here
  onClose = () => {},
  onUpdateCompany = () => {},
  onOpenPerson = () => {},
  onAddPerson = () => {},   // host opens the add-person modal preset to this company
  onDelete = () => {},
  setToast = () => {},
  readOnly = false,
}) {
  const isMobile = useIsMobile()
  const nowMs = Date.now()

  const people = useMemo(
    () => partners.filter(p => p.companyId === company.id && !p.isDeleted),
    [partners, company.id]
  )

  // Last-talked = the freshest of its people (the Phase 2 rule).
  const lastTalkIso = useMemo(() => (
    people.map(p => p.lastContactedAt).filter(Boolean).sort().pop() || null
  ), [people])
  const recency = contactRecency(lastTalkIso, nowMs)

  // ── referrals (direct + via-person, attributed) ──
  const [referrals, setReferrals] = useState(null)
  const [referralsErr, setReferralsErr] = useState(null)
  useEffect(() => {
    let dead = false
    setReferrals(null); setReferralsErr(null)
    fetch(`/api/companies/${company.id}/referrals`)
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`); return r.json() })
      .then(json => { if (!dead) setReferrals(json) })
      .catch(e => { if (!dead) { setReferralsErr(String(e?.message || e)); setReferrals({ referred: [], totals: null, people: [] }) } })
    return () => { dead = true }
  }, [company.id])
  const totals = referrals?.totals ?? null
  const referralCountByPerson = useMemo(() => {
    const m = {}
    for (const p of referrals?.people || []) m[p.id] = p.referral_count || 0
    return m
  }, [referrals])

  // ── rolled-up touchpoints (named) ──
  const [touch, setTouch] = useState(null)
  useEffect(() => {
    let dead = false
    setTouch(null)
    fetch(`/api/companies/${company.id}/touchpoints`)
      .then(r => (r.ok ? r.json() : { touchpoints: [] }))
      .then(json => { if (!dead) setTouch(json.touchpoints || []) })
      .catch(() => { if (!dead) setTouch([]) })
    return () => { dead = true }
  }, [company.id])

  const patch = (fields) => onUpdateCompany({ ...company, ...fields })
  const [confirmDelete, setConfirmDelete] = useState(false)
  const addresses = company.addresses || []
  const firstAddress = addresses[0]?.value || ''

  return (
    <OverlayShell isMobile={isMobile} onClose={onClose} maxWidth={840}>
      <div style={{ padding: '0 20px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

        {/* ── masthead — SQUARE identity (the Option C affordance) ── */}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
          <div data-avatar="company" style={{ width: T.avatar.identity, height: T.avatar.identity, borderRadius: T.radius.control, background: T.brand.sage, color: T.brand.onSage, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: T.avatar.identityFont, fontWeight: 600, flexShrink: 0 }}>
            {(company.name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ fontSize: '19px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{company.name}</h2>
            <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '2px' }}>
              {[company.industry, `${people.length} ${people.length === 1 ? 'person' : 'people'}`].filter(Boolean).join(' · ')}
            </p>
          </div>
          {!readOnly && (
            <RecordMenu ariaLabel="Company actions" items={[
              { key: 'remove', label: 'Delete company', danger: true, onClick: () => setConfirmDelete(true) },
            ]} />
          )}
        </div>

        {confirmDelete && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: T.state.danger.soft, borderRadius: T.radius.control, padding: '10px 12px' }}>
            <span style={{ fontSize: '12px', color: T.state.danger.fg, flex: 1 }}>Delete {company.name}? Its people stay in your network, unlinked.</span>
            <button onClick={async () => { try { await onDelete(company.id); onClose() } catch { setToast({ kind: 'error', msg: 'Delete failed — please try again' }) } }}
              style={{ border: 'none', background: T.state.danger.strong, color: T.ink.inverse, borderRadius: T.radius.control, padding: '6px 12px', fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}>Delete</button>
            <button onClick={() => setConfirmDelete(false)} style={{ border: 'none', background: 'transparent', color: T.ink.muted, fontSize: '12px', cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
          </div>
        )}

        {/* ── stats ── */}
        <div data-testid="company-stats" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <StatTile label="Contacts here" value={people.length} />
          <StatTile label="Leads referred" value={totals ? totals.count : '—'} />
          <StatTile label="Revenue" value={totals ? money(totals.revenue) : '—'} />
          <StatTile label="Last talked" value={fmtLastTalk(lastTalkIso, nowMs) || '—'} danger={recency === 'stale'} />
        </div>
        {referralsErr && <p style={{ fontSize: '11px', color: T.state.danger.fg }}>Referral numbers unavailable ({referralsErr}).</p>}

        {/* ── company facts ── */}
        <div>
          <SectionLabel>Company</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <InlineText label="Industry" value={company.industry} placeholder="add industry" readOnly={readOnly} onSave={v => patch({ industry: v })} />
            <InlineText label="Phone" value={company.phone} href={company.phone ? `tel:${company.phone}` : null} placeholder="add phone" readOnly={readOnly} onSave={v => patch({ phone: v })} />
            <InlineText label="Email" value={company.email} href={company.email ? `mailto:${company.email}` : null} placeholder="add email" readOnly={readOnly} onSave={v => patch({ email: v })} />
            <InlineText label="Website" value={company.website} placeholder="add website" readOnly={readOnly} onSave={v => patch({ website: v })} />
            <InlineText label="Address" value={firstAddress} placeholder="add address" readOnly={readOnly}
              onSave={v => patch({ addresses: v ? [{ type: addresses[0]?.type || 'Office', value: v }, ...addresses.slice(1)] : addresses.slice(1) })} />
          </div>
        </div>

        {/* ── people here ── */}
        <div data-testid="company-people">
          <SectionLabel action={!readOnly && (
            <button onClick={() => onAddPerson(company)}
              style={{ border: 'none', borderRadius: T.radius.control, background: T.accent.fg, color: T.accent.onFill, fontSize: '12px', fontWeight: 500, padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit' }}>
              + Add person
            </button>
          )}>People here · {people.length}</SectionLabel>
          {people.length === 0 && <p style={{ fontSize: '12px', color: T.ink.quiet }}>No one linked yet — add the people you know here.</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {people.map(p => {
              const pRecency = contactRecency(p.lastContactedAt, nowMs)
              const pTalk = fmtLastTalk(p.lastContactedAt, nowMs)
              const badges = deriveNetworkBadges({ partner: p, referralCount: referrals ? (referralCountByPerson[p.id] || 0) : null })
              const stageFam = p.stage ? (T.family[stageFamilyKey(p.stage)] || T.family.gray) : null
              return (
                <div key={p.id} data-person-row={p.id} onClick={() => onOpenPerson(p)}
                  style={{ display: 'flex', alignItems: 'center', gap: '10px', background: T.surface.raised, border: T.border.thin, borderRadius: T.radius.inset, padding: '9px 12px', cursor: 'pointer' }}>
                  <InitialsAvatar name={p.name} bg={T.family.teal.bg} text={T.family.teal.text} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '13px', fontWeight: 600, color: T.ink.primary }}>{p.name}</span>
                      {badges.map(b => <BadgeChip key={b.key} badge={b} />)}
                      {stageFam && <span style={{ fontSize: T.badge.font, fontWeight: 500, color: stageFam.text, background: stageFam.bg, borderRadius: T.radius.chip, padding: '1px 7px' }}>{p.stage}</span>}
                    </div>
                    {p.title && <p style={{ fontSize: '11px', color: T.ink.muted, marginTop: '1px' }}>{p.title}</p>}
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <p style={{ fontSize: '12px', color: T.ink.primary, fontVariantNumeric: T.type.tabular }}>
                      {referrals ? `${referralCountByPerson[p.id] || 0} referred` : '—'}
                    </p>
                    <p data-recency={pRecency} style={{ fontSize: '11px', marginTop: '1px', color: pRecency === 'stale' ? T.state.danger.fg : T.ink.quiet }}>
                      {pTalk ? `talked ${pTalk}` : 'no touchpoints yet'}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* ── touchpoints, rolled up + NAMED ── */}
        <div data-testid="company-touchpoints">
          <SectionLabel>Touchpoints · everyone here</SectionLabel>
          {touch == null && <p style={{ fontSize: '12px', color: T.ink.quiet }}>Loading…</p>}
          {touch != null && touch.length === 0 && <p style={{ fontSize: '12px', color: T.ink.quiet }}>No touchpoints logged with anyone here yet.</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {(touch || []).slice(0, 12).map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', padding: '4px 0' }}>
                <span style={{ fontSize: '12px', color: T.ink.primary, flexShrink: 0 }}>{METHOD_LABEL[t.method] || t.label || 'Touchpoint'}</span>
                <span style={{ fontSize: '12px', color: T.accent.deep, flexShrink: 0 }}>with {t.partner_name || '—'}</span>
                {t.notes && <span style={{ fontSize: '11px', color: T.ink.muted, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.notes}</span>}
                <span style={{ fontSize: '11px', color: T.ink.quiet, marginLeft: 'auto', flexShrink: 0 }}>{fmtLastTalk(t.occurred_at, nowMs)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── leads referred (direct + via people, attributed) ── */}
        <div data-testid="company-referred">
          <SectionLabel>Leads referred{totals ? ` · ${totals.count}` : ''}</SectionLabel>
          {referrals == null && <p style={{ fontSize: '12px', color: T.ink.quiet }}>Loading…</p>}
          {referrals != null && (referrals.referred || []).length === 0 && (
            <p style={{ fontSize: '12px', color: T.ink.quiet }}>Nothing referred from here yet.</p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {(referrals?.referred || []).slice(0, 8).map(r => (
              <a key={r.id} href={`/clients/${r.id}`}
                style={{ display: 'flex', alignItems: 'center', gap: '8px', textDecoration: 'none', padding: '6px 8px', borderRadius: T.radius.control, background: T.surface.sunken }}>
                <span style={{ fontSize: '12px', fontWeight: 500, color: T.ink.primary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                <span style={{ fontSize: '11px', color: T.ink.muted, flexShrink: 0 }}>
                  {r.via?.kind === 'partner' && r.via?.name ? `via ${r.via.name}` : 'company direct'}
                </span>
                {r.revenue > 0 && <span style={{ fontSize: '12px', color: T.ink.primary, fontVariantNumeric: T.type.tabular }}>{money(r.revenue)}</span>}
              </a>
            ))}
          </div>
        </div>
      </div>
    </OverlayShell>
  )
}
