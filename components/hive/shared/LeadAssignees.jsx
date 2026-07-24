// components/hive/shared/LeadAssignees.jsx
// ─────────────────────────────────────────────────────────────
// Lead-level "Assigned to" DISPLAY — the avatar STACK on ClientProfile
// (the Inbox card), reading the lead_assignees junction (plural, the
// real model since the project-type multi-assign build). Faces, not
// names (Kevin 7/24): assignee is identity, so a face reads faster on a
// card you scan, and the stack holds a fixed footprint whatever the
// count — the same treatment the Inbox row uses, so the two match. Full
// names ride the hover title so none is lost.
//
// Display-only: assignment is decided at intake (lib/lead-assignment)
// and edited on the engagement once work is founded; the lead-level
// write path (PUT /api/leads/:id/assignees) exists if an editor is
// wanted here later, but the card only SHOWS who owns the lead today.
//
// `assignees` is the GET /api/leads/:id/assignees shape:
//   { hub_user_id, name, email, jobber_user_id, assigned_via }
// Empty → a quiet "Unassigned", so a lead that still needs an owner
// says so rather than hiding the row.
// ─────────────────────────────────────────────────────────────
import React from 'react'
import { T } from './tokens'
import { MicroLabel } from './cardKit'
import MiniAvatar from './MiniAvatar'

export default function LeadAssignees({ assignees = [] }) {
  const n = assignees.length
  const nameOf = (a) => a.name || a.email || 'Member'
  return (
    <div>
      <MicroLabel>Assigned to</MicroLabel>
      {n === 0 ? (
        <span style={{ fontSize: '12px', color: T.ink.quiet }}>Unassigned</span>
      ) : (
        <span title={assignees.map(nameOf).join(', ')}
          style={{ display: 'inline-flex', alignItems: 'center' }}>
          {assignees.slice(0, 4).map((a, i) => (
            <span key={a.hub_user_id} style={{ display: 'inline-flex', marginLeft: i ? '-8px' : 0 }}>
              <MiniAvatar id={a.hub_user_id} name={nameOf(a)} size="26px" font="11px" ring />
            </span>
          ))}
          {n > 4 && (
            <span style={{ marginLeft: '5px', fontSize: '12px', color: T.ink.muted }}>+{n - 4}</span>
          )}
        </span>
      )}
    </div>
  )
}
