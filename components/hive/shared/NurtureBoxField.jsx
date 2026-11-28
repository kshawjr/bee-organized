// components/hive/shared/NurtureBoxField.jsx
// FL-137/135: the one box on a Closed Lost close — "Add them to Nurturing
// (and Mailchimp)". Unticked by default, and unticked is a real "no" (see
// nurtureBox.js). Shown only when nurtureBoxShows(reason). Props only.
'use client'

import React from 'react'
import { nurtureBoxLabel, nurtureBoxHint } from './nurtureBox'
import { mailchimpOpenFor } from '@/lib/mailchimp-rollout'
import { T } from './tokens'

export default function NurtureBoxField({ checked, onChange, locationUuid, disabled = false }) {
  const open = mailchimpOpenFor(locationUuid)
  return (
    <label data-testid="nurture-box" style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '10px 12px', borderRadius: T.radius.control, border: `0.5px solid ${T.hairline.line}`, background: T.surface.raised, cursor: disabled ? 'default' : 'pointer' }}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: '2px', width: '16px', height: '16px', flex: 'none' }} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span style={{ fontSize: '13px', fontWeight: 500, color: T.ink.primary }}>{nurtureBoxLabel(open)}</span>
        <span style={{ fontSize: '11px', color: T.ink.muted }}>{nurtureBoxHint(open)}</span>
      </span>
    </label>
  )
}
