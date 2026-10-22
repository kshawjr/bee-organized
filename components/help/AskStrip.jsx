// components/help/AskStrip.jsx
// ─────────────────────────────────────────────────────────────
// THE THREE DOORS — the guided intake's own three, so the type is chosen here
// and the form opens straight on question 1. Carries where the owner was: the
// breadcrumb in words as `about` (stored as an "About:" line under the
// answers, visible to triage) and the entry id in context.
//
// AT THE TOP, not the bottom. They used to end every Help level, after the
// entire article list, and they were missing from My requests altogether — the
// one screen whose whole subject is "things you've told us". Now they open
// both: above the article list on every Help level, and above the reports on
// My requests. Its own file so OwnerFeedbackScreen can mount it without
// importing HelpScreen (which imports OwnerFeedbackScreen).
//
// ON A PHONE THE DOORS STACK, full width, each a 46px tap target.
'use client'

import React from 'react'
import { T } from '@/components/hive/shared/tokens'
import useIsMobile from '@/components/hive/shared/useIsMobile'
import { helpBreadcrumb } from '@/lib/help-content'

// variant 'help'     — a Help level; `crumbs` say which.
// variant 'requests' — the top of My requests; the reply turns up right below.
export function AskStrip({ crumbs = [], onAsk, stripRef = null, variant = 'help' }) {
  const isMobile = useIsMobile()
  const requests = variant === 'requests'
  const where = requests ? 'My requests' : (helpBreadcrumb(crumbs) || 'Help')
  const deepest = requests ? null : ([...crumbs].reverse().find(c => c && c.id) || null)
  const ask = (type) => onAsk?.({
    type,
    about: where,
    context: { origin: 'help_ask_strip', screen: 'Help', ...(deepest ? { help_entry_id: deepest.id } : {}) },
  })
  const door = {
    minHeight: '46px', padding: '10px 14px', borderRadius: T.radius.inset,
    fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer',
    ...(isMobile ? { width: '100%', textAlign: 'left' } : {}),
  }
  const quiet = { ...door, background: T.surface.raised, color: T.ink.primary, border: T.border.control }
  const loud = { ...door, background: T.ink.primary, color: T.ink.inverse, border: 'none' }
  return (
    <div ref={stripRef} data-help-ask-strip={variant} style={{ marginBottom: '18px', background: T.surface.sunken, border: T.border.thin, borderRadius: T.radius.inset, padding: '16px' }}>
      <p style={{ margin: '0 0 10px', fontSize: '14.5px', color: T.ink.secondary, lineHeight: 1.5 }}>
        {requests
          ? <>Something new to tell us? A person reads every one and writes back — the reply turns up right here.</>
          : crumbs.length === 0
            ? <>Can&rsquo;t find what you need? A person reads every one and writes back — the reply lands under My requests.</>
            : <>Can&rsquo;t find it in <b style={{ color: T.ink.primary }}>{where}</b>? A person reads every one and writes back — the reply lands under My requests.</>}
      </p>
      <div data-help-doors style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', flexDirection: isMobile ? 'column' : 'row' }}>
        <button type="button" onClick={() => ask('bug')} data-help-door="bug" style={quiet}>
          🐛 Report a bug
        </button>
        <button type="button" onClick={() => ask('question')} data-help-door="question" style={loud}>
          ❓ Ask a question
        </button>
        <button type="button" onClick={() => ask('feature')} data-help-door="feature" style={quiet}>
          ✨ Share an idea
        </button>
      </div>
    </div>
  )
}

export default AskStrip
