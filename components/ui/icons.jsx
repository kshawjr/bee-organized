// components/ui/icons.jsx — minimal inline icon set (Tabler Icons, MIT —
// https://tabler.io/icons), stroke-based, currentColor so icons inherit
// the family color already threaded via the surrounding text/iconColor.
// Inlined deliberately: no npm dependency, no icon font, tree-shakes with
// the beta chunk. Default 16px; pass size for 14px tab icons etc.
'use client'

import React from 'react'

function make(children) {
  return function Icon({ size = 16, style = {} }) {
    return (
      <svg
        width={size} height={size} viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ flexShrink: 0, display: 'inline-block', verticalAlign: '-2px', ...style }}
        aria-hidden="true"
      >
        {children}
      </svg>
    )
  }
}

export const IconInbox = make(<>
  <rect x="4" y="4" width="16" height="16" rx="2" />
  <path d="M4 13h3l3 3h4l3 -3h3" />
</>)

export const IconFileText = make(<>
  <path d="M14 3v4a1 1 0 0 0 1 1h4" />
  <path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" />
  <path d="M9 9h1" /><path d="M9 13h6" /><path d="M9 17h6" />
</>)

export const IconHammer = make(<>
  <path d="M11.414 10l-7.383 7.418a2.091 2.091 0 0 0 0 2.967a2.11 2.11 0 0 0 2.976 0l7.407 -7.385" />
  <path d="M18.121 15.293l2.586 -2.586a1 1 0 0 0 0 -1.414l-7.586 -7.586a1 1 0 0 0 -1.414 0l-2.586 2.586a1 1 0 0 0 0 1.414l7.586 7.586a1 1 0 0 0 1.414 0z" />
</>)

export const IconFileInvoice = make(<>
  <path d="M14 3v4a1 1 0 0 0 1 1h4" />
  <path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" />
  <path d="M9 7h1" /><path d="M9 13h6" /><path d="M13 17h2" />
</>)

export const IconSend = make(<>
  <path d="M10 14l11 -11" />
  <path d="M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5" />
</>)

export const IconCheck = make(<path d="M5 12l5 5l10 -10" />)

export const IconClock = make(<>
  <circle cx="12" cy="12" r="9" />
  <path d="M12 7v5l3 3" />
</>)

export const IconCalendar = make(<>
  <rect x="4" y="5" width="16" height="16" rx="2" />
  <path d="M16 3v4" /><path d="M8 3v4" /><path d="M4 11h16" />
</>)

export const IconCash = make(<>
  <rect x="7" y="9" width="14" height="10" rx="2" />
  <circle cx="14" cy="14" r="2" />
  <path d="M17 9v-2a2 2 0 0 0 -2 -2h-10a2 2 0 0 0 -2 2v6a2 2 0 0 0 2 2h2" />
</>)

export const IconPhone = make(
  <path d="M5 4h4l2 5l-2.5 1.5a11 11 0 0 0 5 5l1.5 -2.5l5 2v4a2 2 0 0 1 -2 2a16 16 0 0 1 -15 -15a2 2 0 0 1 2 -2" />
)

export const IconPhoneOutgoing = make(<>
  <path d="M5 4h4l2 5l-2.5 1.5a11 11 0 0 0 5 5l1.5 -2.5l5 2v4a2 2 0 0 1 -2 2a16 16 0 0 1 -15 -15a2 2 0 0 1 2 -2" />
  <path d="M15 9l6 -6" /><path d="M16 3h5v5" />
</>)

export const IconSparkles = make(
  <path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z" />
)

export const IconPlayerPause = make(<>
  <rect x="6" y="5" width="4" height="14" rx="1" />
  <rect x="14" y="5" width="4" height="14" rx="1" />
</>)

export const IconChevronRight = make(<path d="M9 6l6 6l-6 6" />)

export const IconExternalLink = make(<>
  <path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6" />
  <path d="M11 13l9 -9" /><path d="M15 4h5v5" />
</>)

export const IconX = make(<>
  <path d="M18 6l-12 12" /><path d="M6 6l12 12" />
</>)

export const IconUsers = make(<>
  <circle cx="9" cy="7" r="4" />
  <path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2" />
  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  <path d="M21 21v-2a4 4 0 0 0 -3 -3.85" />
</>)

export const IconList = make(<>
  <path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" />
  <path d="M5 6v.01" /><path d="M5 12v.01" /><path d="M5 18v.01" />
</>)

export const IconLayoutKanban = make(<>
  <path d="M4 4h6v8h-6z" /><path d="M4 16h6v4h-6z" />
  <path d="M14 4h6v4h-6z" /><path d="M14 12h6v8h-6z" />
</>)

// Within-stage status → leading icon (mockup chips/status text). One map
// so board chips and list status text pick identical glyphs.
const STATUS_ICON = {
  sent: IconSend,
  approved: IconCheck,
  paid: IconCheck,
  scheduled: IconCalendar,
  upcoming: IconCalendar,
  in_progress: IconClock,
  nurturing: IconClock,
  changes_requested: IconClock,
  owing: IconCash,
  never_invoiced: IconFileInvoice,
  Request: IconInbox,
  amber: IconClock,
}

export function statusIconFor(styleKey, size = 11) {
  const C = STATUS_ICON[styleKey]
  return C ? <C size={size} /> : null
}
