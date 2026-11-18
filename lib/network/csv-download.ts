// lib/network/csv-download.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 5 — handing a CSV file to the browser.
// This is the piece slice 1 left behind on purpose (lib/network/csv.ts is
// pure; this one touches the page).
//
// The file starts with a byte-order mark so Excel opens it as UTF-8: without
// it, an emoji or an accented name turns into junk. lib/network/csv.ts
// parseCsv takes the mark off again, so an exported file reads straight back
// in.
// ─────────────────────────────────────────────────────────────

import { contactsToCsv } from './csv'
import type { NetContact } from './types'

const BOM = '﻿'

/** "network-portland-2026-11-17.csv". Letters and digits only in the place name. */
export function exportFileName(locationName: string, date: Date): string {
  const place = String(locationName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'location'
  const day = date.toLocaleDateString('en-CA') // YYYY-MM-DD, the viewer's own day
  return `network-${place}-${day}.csv`
}

/** The text of the file, exactly as it is saved (mark included). */
export function exportText(contacts: readonly NetContact[]): string {
  return BOM + contactsToCsv(contacts) + '\n'
}

/** Give the browser the file to save. Answers the text it saved, for tests. */
export function downloadText(filename: string, text: string, doc: Document = document): string {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = doc.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  doc.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return text
}
