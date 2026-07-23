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
import { T, sage } from './shared/tokens'

// Existing shell colors, single-homed in tokens (T.scope.* — the dark
// sub-surface family — plus the sage helper); nothing new beyond what
// the sidebar + chips already use.
const AVATAR_AMBER = T.scope.avatarAmber
const RING_AMBER = T.scope.ringAmber
// The initials ride a GOLD disc. White on brand gold is 2.35:1 — the
// banned pair — so the disc keeps its brand brightness and the initials
// go dark instead of the disc going dim.
const ON_AMBER = T.scope.onAmber
const SAGE = sage

const rowBase = {
  width: '100%', display: 'flex', alignItems: 'center', gap: '10px',
  padding: '9px 14px', border: 'none', background: 'transparent',
  fontFamily: 'inherit', textAlign: 'left', boxSizing: 'border-box',
}

function SectionLabel({ children }) {
  return (
    <p style={{ fontSize: '11px', fontWeight: 500, color: T.ink.muted, letterSpacing: '0.6px', textTransform: 'uppercase', padding: '10px 14px 2px' }}>
      {children}
    </p>
  )
}

function Divider() {
  return <div data-divider="true" style={{ height: '1px', background: T.hairline.soft }} />
}

function Row({ icon, title, subline, onClick, chevron = false, muted = false }) {
  const inner = (
    <>
      <span style={{ display: 'inline-flex', color: muted ? T.ink.muted : T.ink.strong, flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: muted ? T.ink.muted : T.ink.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {subline && <span style={{ display: 'block', fontSize: '11px', color: T.ink.muted, marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subline}</span>}
      </span>
      {chevron && <span style={{ display: 'inline-flex', color: T.ink.quiet, flexShrink: 0 }}><IconChevronRight size={14} /></span>}
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
          padding: '10px 12px', borderRadius: T.radius.inset,
          background: T.scope.onDarkSoft,
          border: T.scope.onDarkBorder,
          boxShadow: impersonating ? `0 0 0 2px ${RING_AMBER}` : 'none',
          cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', boxSizing: 'border-box',
        }}
      >
        <span style={{ width: '32px', height: '32px', borderRadius: T.radius.round, background: AVATAR_AMBER, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700, color: ON_AMBER, flexShrink: 0 }}>
          {initials}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: impersonating ? RING_AMBER : T.ink.inverse, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
            style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, width: '256px', zIndex: 10002, background: T.surface.raised, borderRadius: T.radius.inset, border: T.border.thin, boxShadow: T.shadow.drawer, overflow: 'hidden', paddingBottom: '4px' }}
          >
            <style>{`.bee-idsc-row:hover { background: ${T.surface.hover} }`}</style>

            {/* 1 · Identity — always the REAL signed-in identity */}
            <div data-section="identity" style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px' }}>
              <span style={{ width: '34px', height: '34px', borderRadius: T.radius.round, background: AVATAR_AMBER, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, color: ON_AMBER, flexShrink: 0 }}>
                {initials}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: T.ink.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                {email && <span style={{ display: 'block', fontSize: '11px', color: T.ink.muted, marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</span>}
              </span>
              {roleLabel && (
                <span style={{ flexShrink: 0, padding: '2px 8px', borderRadius: T.radius.chip, background: badge.bg, color: badge.text, fontSize: '11px', fontWeight: 500, whiteSpace: 'nowrap' }}>
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
                <span style={{ display: 'inline-flex', color: T.ink.muted, flexShrink: 0 }}><IconLogout size={15} /></span>
                <span style={{ flex: 1, fontSize: '13px', fontWeight: 500, color: T.ink.muted }}>Sign out</span>
              </a>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
