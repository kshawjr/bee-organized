// lib/booking-link-health.ts
//
// Missing-booking-link rollup for the ops digest: ACTIVE locations whose
// default drip path asks the client to click a scheduling link (path letter
// -b/-d, the "calendar" paths) while locations.calendar_link is blank. Every
// such location has its booking sends HELD by lib/booking-link — this is the
// per-location view of that hold, surfaced where Kevin already reads import
// and blank-rate health. Deliberately the same shape as lib/rate-health.ts.
//
// Classification is BY DEFAULT PATH and BY calendar_link, i.e. the
// location-level signal an owner acts on: set the location link or switch
// paths. Two things it deliberately does NOT do:
//
//   • It does not read hub_users.booking_link. Per-user links only ever ADD
//     a tier above calendar_link, so a location with a blank calendar_link is
//     still one unassigned lead away from a held send — the rollup should
//     name it either way. (It also keeps this query working before
//     migrations/hub_users_booking_link.sql is applied.)
//   • It does not replace the guard. The send guard is template-source based
//     and stays authoritative — a customized -a/-c template that quotes a
//     booking tag is still held even though it won't show in this rollup.

import { supabaseService } from './supabase-service'

// organizing-b / organizing-d / moving-b / moving-d point the client at a
// calendar (see migrations/seed_master_drip_paths.sql); -a / -c don't.
export function isBookingPathKey(pathKey: string | null | undefined): boolean {
  return typeof pathKey === 'string' && /-(b|d)$/.test(pathKey)
}

export type BookingLinkHealthRow = {
  location_id: string | null   // slug ('loc_seattle') — matches digest conventions
  name: string | null
  paths: string[]              // the booking default path(s), e.g. ['organizing-d','moving-d']
}

// Never throws — the digest must not die on a locations read hiccup; the
// caller degrades to an empty rollup (and the send guard still holds).
export async function fetchBookingLinkHealth(): Promise<{ missingLink: BookingLinkHealthRow[] }> {
  try {
    const { data, error } = await supabaseService
      .from('locations')
      .select('location_id, name, lifecycle_status, default_drip_path, default_move_drip_path, calendar_link')
      .eq('lifecycle_status', 'active')
    if (error || !data) {
      if (error) console.error('[booking-link-health] locations read failed (non-fatal)', error.message)
      return { missingLink: [] }
    }
    const missingLink: BookingLinkHealthRow[] = []
    for (const row of data as any[]) {
      const link = typeof row.calendar_link === 'string' ? row.calendar_link.trim() : ''
      if (link) continue
      const paths = [row.default_drip_path, row.default_move_drip_path].filter(isBookingPathKey) as string[]
      if (paths.length === 0) continue
      missingLink.push({
        location_id: row.location_id ?? null,
        name: row.name ?? null,
        paths,
      })
    }
    return { missingLink }
  } catch (err: any) {
    console.error('[booking-link-health] unexpected error (non-fatal)', err?.message || err)
    return { missingLink: [] }
  }
}
