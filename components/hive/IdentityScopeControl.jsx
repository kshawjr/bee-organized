// components/hive/IdentityScopeControl.jsx
// ─────────────────────────────────────────────────────────────
// THE sidebar-bottom identity + scope control — the merge of the three
// scattered "who/where am I viewing as" facets (old top super-admin
// strip, sidebar location switcher, sidebar avatar/sign-out block) into
// ONE popover. The top strip is deleted; this is its replacement.
//
// Closed trigger = avatar + name on line 1, map-pin + current scope on
// line 2 (REQUIRED — scope must be readable without opening; that's
// what justified removing the strip). When impersonation is ACTIVE the
// trigger itself goes loud: amber ring + "Viewing as <Name>" — the
// always-visible cue the deleted strip used to provide. Never let that
// state live only inside the closed popover.
//
// Popover sections, top→bottom, degrading by role:
//   identity (everyone) → viewing-as (REAL super admin ONLY — omitted,
//   never disabled, for anyone else) → location (switch row for
//   multi-location viewers, static "Your location" row otherwise) →
//   sign out, fenced below its OWN divider so the one irreversible
//   action never sits flush against a scope row.
//
// §8.5: beta-chunk module. No BeeHub imports — identity, scope state,
// and the handlers arrive as props passed DOWN (the same handlers the
// old strip / old switcher called; this component relocates them, it
// does not fork them).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import { CHIP_STYLES } from './shared/stageConfig'
import { IconMapPin, IconSelector, IconEye, IconLogout, IconChevronRight } from '@/components/ui/icons'

// Existing shell colors, reused (sidebar green family / avatar amber) —
// no new hex beyond what the sidebar + chips already use.
const AVATAR_AMBER = 'linear-gradient(135deg,#d4a046,#b07a20)'
const RING_AMBER = '#d4a046'
const SAGE = (a) => `rgba(168,201,196,${a})`

const rowBase = {
  width: '100%', display: 'flex', alignItems: 'center', gap: '10px',
  padding: '9px 14px', border: 'none', background: 'transparent',
  fontFamily: 'inherit', textAlign: 'left', boxSizing: 'border-box',
}

function SectionLabel({ children }) {
  return (
    <p style={{ fontSize: '11px', fontWeight: 500, color: '#8a8a84', letterSpacing: '0.6px', textTransform: 'uppercase', padding: '10px 14px 2px' }}>
      {children}
    </p>
  )
}

function Divider() {
  return <div data-divider="true" style={{ height: '1px', background: 'rgba(0,0,0,0.07)' }} />
}

function Row({ icon, title, subline, onClick, chevron = false, muted = false }) {
  const inner = (
    <>
      <span style={{ display: 'inline-flex', color: muted ? '#8a8a84' : '#444441', flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: muted ? '#8a8a84' : '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {subline && <span style={{ display: 'block', fontSize: '11px', color: '#8a8a84', marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subline}</span>}
      </span>
      {chevron && <span style={{ display: 'inline-flex', color: '#b5b3ac', flexShrink: 0 }}><IconChevronRight size={14} /></span>}
    </>
  )
  if (!onClick) return <div style={rowBase}>{inner}</div>
  return <button onClick={onClick} className="bee-idsc-row" style={{ ...rowBase, cursor: 'pointer' }}>{inner}</button>
}

export default function IdentityScopeControl({
  name = '',
  email = '',
  initials = '',
  roleLabel = '',
  roleBadgeTint = 'accent', // 'warning' (super admin) | 'accent' (owner etc.)
  isSuperAdmin = false, // REAL super admin — gates the Viewing-as section
  viewingAs = null, // { name, roleLabel } while impersonating, else null
  locationLabel = 'All locations',
  locationCount = 1,
  canSwitchLocation = false,
  onOpenViewAs = () => {},
  onExitViewAs = () => {},
  onOpenLocationPicker = () => {},
  signOutHref = '/api/auth/signout',
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const impersonating = !!viewingAs
  const badge = roleBadgeTint === 'warning' ? CHIP_STYLES.amber : CHIP_STYLES.teal
  const pick = (fn) => () => { setOpen(false); fn() }

  return (
    <div style={{ position: 'relative' }}>
      {/* Trigger — closed-state scope line is REQUIRED; impersonation is
          loud here (ring + "Viewing as") even with the popover closed. */}
      <button
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account and scope"
        data-impersonating={impersonating ? 'true' : undefined}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: '10px',
          padding: '10px 12px', borderRadius: '12px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: impersonating ? `0 0 0 2px ${RING_AMBER}` : 'none',
          cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', boxSizing: 'border-box',
        }}
      >
        <span style={{ width: '32px', height: '32px', borderRadius: '50%', background: AVATAR_AMBER, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700, color: 'white', flexShrink: 0 }}>
          {initials}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: impersonating ? RING_AMBER : 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {impersonating ? `Viewing as ${viewingAs.name}` : name}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px', color: SAGE(0.6), marginTop: '2px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            <IconMapPin size={11} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{locationLabel}</span>
          </span>
        </span>
        <span style={{ display: 'inline-flex', color: SAGE(0.45), flexShrink: 0 }}><IconSelector size={15} /></span>
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10001 }} />
          <div
            role="menu"
            style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, width: '256px', zIndex: 10002, background: '#fff', borderRadius: '12px', border: '0.5px solid rgba(0,0,0,0.12)', boxShadow: '0 12px 40px rgba(26,26,24,0.22)', overflow: 'hidden', paddingBottom: '4px' }}
          >
            <style>{`.bee-idsc-row:hover { background: #f7f6f4 }`}</style>

            {/* 1 · Identity — always the REAL signed-in identity */}
            <div data-section="identity" style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px' }}>
              <span style={{ width: '34px', height: '34px', borderRadius: '50%', background: AVATAR_AMBER, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, color: 'white', flexShrink: 0 }}>
                {initials}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                {email && <span style={{ display: 'block', fontSize: '11px', color: '#8a8a84', marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</span>}
              </span>
              {roleLabel && (
                <span style={{ flexShrink: 0, padding: '2px 8px', borderRadius: '10px', background: badge.bg, color: badge.text, fontSize: '11px', fontWeight: 500, whiteSpace: 'nowrap' }}>
                  {roleLabel}
                </span>
              )}
            </div>

            {/* 2 · Viewing as — REAL super admin only; omitted (never
                disabled) for everyone else */}
            {isSuperAdmin && (
              <div data-section="viewing-as">
                <Divider />
                <SectionLabel>Viewing as</SectionLabel>
                <Row
                  icon={<IconEye size={15} />}
                  title={impersonating ? viewingAs.name : 'Yourself'}
                  subline={impersonating ? (viewingAs.roleLabel || 'Impersonating') : 'Not impersonating anyone'}
                  chevron
                  onClick={pick(onOpenViewAs)}
                />
                {impersonating && (
                  <Row
                    icon={<IconEye size={15} />}
                    title="Return to yourself"
                    muted
                    onClick={pick(onExitViewAs)}
                  />
                )}
              </div>
            )}

            {/* 3 · Location — switcher for multi-location viewers, static
                read-only row when scoped to one location */}
            <div data-section="location">
              <Divider />
              <SectionLabel>Location</SectionLabel>
              <Row
                icon={<IconMapPin size={15} />}
                title={locationLabel}
                subline={canSwitchLocation ? `${locationCount} franchise location${locationCount === 1 ? '' : 's'}` : 'Your location'}
                chevron={canSwitchLocation}
                onClick={canSwitchLocation ? pick(onOpenLocationPicker) : null}
              />
            </div>

            {/* 4 · Sign out — fenced below its own divider, never flush
                against a scope row (the one irreversible action) */}
            <div data-section="signout">
              <Divider />
              <a href={signOutHref} className="bee-idsc-row" style={{ ...rowBase, cursor: 'pointer', textDecoration: 'none', marginTop: '4px' }}>
                <span style={{ display: 'inline-flex', color: '#8a8a84', flexShrink: 0 }}><IconLogout size={15} /></span>
                <span style={{ flex: 1, fontSize: '13px', fontWeight: 500, color: '#8a8a84' }}>Sign out</span>
              </a>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
