// lib/email-body-save.ts
//
// What a SAVE writes for an email body (2026-11-13, slice 2a of the rich-text
// editor). One rule for every route that stores drip_path_steps.body or
// templates.body:
//
//   the request says body_format: 'html'  → the body is rebuilt from the
//       whitelist (lib/email-body-html.ts sanitizeEmailHtml) HERE, on the
//       server, whatever the screen already did, and the row is marked html.
//   anything else                         → the body is stored as typed and
//       the row is marked plain.
//
// The mark matters in both directions: the send reads it to decide whether a
// body is text to escape or tags to keep, so a body and its mark are always
// written together.
//
// BEFORE migrations/email_body_format.sql HAS RUN the column is not there.
// A plain save then simply goes without the mark (it is what the column would
// default to); an html save is refused, because an html body in a row the
// send would read as plain text reaches the client as raw tags.

import { sanitizeEmailHtml, type BodyFormat } from './email-body-html'

export const BODY_FORMAT_MIGRATION = 'migrations/email_body_format.sql'

export function bodyFormatIn(v: unknown): BodyFormat {
  return v === 'html' ? 'html' : 'plain'
}

export function bodyForSave(body: string, format: unknown): { body: string; body_format: BodyFormat } {
  return bodyFormatIn(format) === 'html'
    ? { body: sanitizeEmailHtml(body), body_format: 'html' }
    : { body, body_format: 'plain' }
}

// Postgres / PostgREST saying the body_format column does not exist yet.
export function isMissingBodyFormatColumn(error: { message?: string } | null | undefined): boolean {
  const m = error?.message || ''
  return /body_format/.test(m) && /does not exist|schema cache/i.test(m)
}
