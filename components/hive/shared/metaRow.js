// components/hive/shared/metaRow.js
// ─────────────────────────────────────────────────────────────
// THE meta-row anatomy — one implementation of the "icon · muted label ·
// value" line that every key-fact/contact row on the lead-detail cards
// renders (ContactField phone/email, AddressField, SourceField,
// ReferrerField, PersonCard's read-only contact rows).
//
// Why this exists: the anatomy was copy-pasted five times with the same
// numbers typed out each time, so a row that forgot one of them (the
// referrer line: no icon, no label treatment, no line-height) sat at a
// different left edge and a different height than the rows above it.
// Kevin caught it on the Inbox card. The values now live HERE, once, and
// the rows read them — a rhythm drift is no longer possible by omission.
//
// Rules the anatomy encodes:
//   · 12px text, 1.4 line-height — one type size for every meta line
//     (the 11px pill scale is for CHIPS, not for rows)
//   · a 13px leading icon in muted ink, flex-shrink 0 — this is what
//     puts every row's VALUE on the same left edge
//   · 7px icon→value gap
//   · the leading word ("Source: ", "Referred by ") is a MUTED label,
//     the value is primary ink
//   · rows carry data-meta-row so a mount test can assert two rows share
//     the anatomy rather than re-typing the numbers into an assertion
//
// PURE module (tokens only) — safe in any bundle. No hex/rgba literals:
// every color resolves through shared/tokens.
// ─────────────────────────────────────────────────────────────

import { T } from './tokens'

// The leading-icon size every meta row renders at.
export const META_ICON = 13

// tone: 'primary' (a real value) | 'faint' (the add-… empty state)
// interactive: the row IS the control (a <button>) rather than a <p>
export const metaRowStyle = ({ tone = 'primary', interactive = false } = {}) => ({
  display: 'flex',
  alignItems: 'center',
  gap: '7px',
  minWidth: 0,
  margin: 0,
  fontSize: '12px',
  lineHeight: 1.4,
  fontFamily: 'inherit',
  color: tone === 'faint' ? T.ink.faint : T.ink.primary,
  ...(interactive
    ? { width: '100%', padding: 0, border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer' }
    : {}),
})

// The leading icon well — muted ink, never shrinks (a shrinking icon is
// what breaks the shared left edge on a narrow phone).
export const metaIconStyle = { color: T.ink.muted, display: 'inline-flex', flexShrink: 0 }

// The label half of the line ("Source: ", "Referred by ").
export const metaLabelStyle = { color: T.ink.muted }

// The value half — one line, ellipsis rather than a wrap that would
// break the row's rhythm.
export const metaValueStyle = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

// The dashed-underline affordance on an empty-state row ('add source').
export const metaAddStyle = { borderBottom: T.border.underline }
