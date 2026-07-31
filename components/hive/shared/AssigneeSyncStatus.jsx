// components/hive/shared/AssigneeSyncStatus.jsx
// ─────────────────────────────────────────────────────────────
// issue 148 — the assignee → Jobber status line.
//
// POST/DELETE /api/engagements/:id/assignees returns a jobber_sync object
// describing how the crew push to Jobber went, and until now NOTHING on
// screen read it — the same silence that let assignment fail unseen for
// three weeks, just in a different place. Unlike the send path, this is a
// LIVE interactive action: a person clicked and is sitting there to be
// told. This turns that response into ONE inline line under the assignee
// picker, spoken to a non-technical owner about THEIR work — never about
// the system (no mutation names, no error codes, no "sync failed").
//
// SILENT ON SUCCESS. No checkmark, no "synced." The line appears ONLY when
// there is something the person needs to know:
//   · a leg FAILED  → saved here, Jobber didn't take the crew, try again
//   · unmapped > 0  → saved, but N people aren't linked to Jobber
// A null sync (location not connected to Jobber — assignment is internal-
// only there BY DESIGN) and a clean, fully-synced push both render NOTHING.
//
// Confirmed jobber_sync shape (post issues 147 + 153, read live from
// lib/engagement-assignee-sync AssignmentSyncResult):
//   { request:'skipped', job, assessment, mapped, unmapped, visitsTouched } | null
//     job        : 'synced' | 'cleared' | 'failed' | 'none'
//     assessment : 'synced' | 'failed'  | 'none'   (issue 147 rewrote this
//                  leg to assessmentEdit; 'cleared' is in the type but the
//                  assessment axis never emits it)
// The failure axis is job==='failed' OR assessment==='failed'. A failed leg
// beats the unmapped note — the retry matters more than the FYI.
//
// §8.5 props only, no context. Token-pure (T.* everywhere, beta-hive-tokens
// source sweep — zero raw hex, including in comments).
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import { T } from './tokens'

// Pure map: jobber_sync → the note to show, or null for silence. Exported so
// a mount test can assert the four cases (fail / unmapped / clean / null)
// without standing up a fetch.
export function assigneeSyncNote(sync) {
  if (!sync) return null // null = location not on Jobber (internal-only) — silent by design

  const failed = sync.job === 'failed' || sync.assessment === 'failed'
  if (failed) {
    return {
      tone: 'fail',
      text: 'Saved here, but couldn’t update Jobber — the crew may not show on the assessment or job yet. Try again shortly.',
    }
  }

  const unmapped = Number(sync.unmapped) || 0
  if (unmapped > 0) {
    const who = unmapped === 1
      ? 'One of these people isn’t'
      : `${unmapped} of these people aren’t`
    return {
      tone: 'info',
      text: `Saved. ${who} linked to Jobber, so they were assigned in Bee Hub only.`,
    }
  }

  return null // clean, fully-synced push — silent
}

export default function AssigneeSyncStatus({ sync }) {
  const note = assigneeSyncNote(sync)
  if (!note) return null
  // Failure wears the warning ink (a caution, not a hard error — the
  // assignment DID save here); the unmapped FYI stays quiet, muted detail.
  const color = note.tone === 'fail' ? T.state.warning.fg : T.ink.muted
  return (
    <p role="status" aria-live="polite" data-bee-assignee-sync
      style={{ margin: '2px 0 0', fontSize: '13px', lineHeight: 1.4, color, maxWidth: '52ch' }}>
      {note.text}
    </p>
  )
}
