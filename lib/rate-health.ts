// lib/rate-health.ts
//
// Blank-rate rollup for the ops digest: ACTIVE locations whose default
// drip path quotes {{rate_per_hour}} (path letter -a/-b, the "rates"
// paths) while locations.rate_per_hour is blank. Every such location has
// its rate-quoting sends HELD by lib/rate-guard.ts — this is the
// per-location view of that hold, surfaced where Kevin already reads
// import health.
//
// Classification here is BY DEFAULT PATH (the location-level signal an
// owner acts on: set the rate or switch paths). The send guard itself is
// template-source-based and stays authoritative — a customized C/D
// template that quotes the tag is still held even though it won't show
// in this rollup.

import { supabaseService } from './supabase-service'

// organizing-a / organizing-b / moving-a / moving-b quote the rate in
// their Email 1 (see migrations/seed_master_drip_paths.sql); -c / -d
// move pricing to the call.
export function isRateQuotingPathKey(pathKey: string | null | undefined): boolean {
  return typeof pathKey === 'string' && /-(a|b)$/.test(pathKey)
}

export type RateHealthRow = {
  location_id: string | null   // slug ('loc_seattle') — matches digest conventions
  name: string | null
  paths: string[]              // the rate-quoting default path(s), e.g. ['organizing-b','moving-b']
}

// Never throws — the digest must not die on a locations read hiccup; the
// caller degrades to an empty rollup (and the send guard still holds).
export async function fetchRateHealth(): Promise<{ missingRate: RateHealthRow[] }> {
  try {
    const { data, error } = await supabaseService
      .from('locations')
      .select('location_id, name, lifecycle_status, default_drip_path, default_move_drip_path, rate_per_hour')
      .eq('lifecycle_status', 'active')
    if (error || !data) {
      if (error) console.error('[rate-health] locations read failed (non-fatal)', error.message)
      return { missingRate: [] }
    }
    const missingRate: RateHealthRow[] = []
    for (const row of data as any[]) {
      const rate = typeof row.rate_per_hour === 'string' ? row.rate_per_hour.trim() : ''
      if (rate) continue
      const paths = [row.default_drip_path, row.default_move_drip_path].filter(isRateQuotingPathKey) as string[]
      if (paths.length === 0) continue
      missingRate.push({
        location_id: row.location_id ?? null,
        name: row.name ?? null,
        paths,
      })
    }
    return { missingRate }
  } catch (err: any) {
    console.error('[rate-health] unexpected error (non-fatal)', err?.message || err)
    return { missingRate: [] }
  }
}
