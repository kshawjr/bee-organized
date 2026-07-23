// lib/partner-writes.ts
// ─────────────────────────────────────────────────────────────
// THE partner update path (the closeEngagement.js pattern: one write module,
// BeeHub wires state around it). Replaces the App-level fire-and-forget:
//
//   setPartners(optimistic); fetch(PATCH whole object).catch(console.error)
//
// which had two real failure modes:
//   · whole-object PATCH — two concurrent editors clobber each other's
//     untouched fields (last write wins on EVERYTHING, not just the edit)
//   · .catch(console.error) — fetch only rejects on network death; a 4xx/5xx
//     resolved fine, so a genuinely failed save kept the optimistic state on
//     screen LOOKING saved, forever
//
// Contract now:
//   · computePartnerPatch(prev, next) → the MINIMAL field-level patch
//     (known API fields only, deep-compared, so untouched fields never
//     travel and can't clobber)
//   · makeUpdatePartner(deps) → the updatePartner the PartnersContext
//     exposes: optimistic apply → PATCH the diff → on ANY failure (network
//     OR non-ok status) revert to the pre-edit row + surface a toast.
//     On success, reconcile with the server row (authoritative).
//   · no-op diffs skip the network entirely.
// ─────────────────────────────────────────────────────────────

// The API-known camelCase fields (mirror of lib/crm.ts PARTNER_FIELD_MAP —
// partnerPatchToRow only copies these, so diffing anything else would send
// keys the API drops anyway).
export const PARTNER_PATCH_FIELDS = [
  'type', 'name', 'title', 'company', 'companyId', 'phone', 'email', 'website',
  'stage', 'specialties', 'tier', 'tags', 'howWeMet', 'metDate', 'lastContact',
  'isCustomer', 'customerLeadId', 'relationship', 'cardImage', 'addresses',
  'notes', 'nextSteps', 'referrals', 'activity',
] as const

const eq = (a: any, b: any) => {
  if (a === b) return true
  // Arrays / embedded jsonb sub-records — value comparison, order-sensitive
  // (order IS meaning for notes/activity/nextSteps).
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
  }
  return false
}

// Minimal changed-fields patch. `restore` rides through when the caller sets
// it (the recycle-bin path PATCHes { restore: true }).
export function computePartnerPatch(
  prev: Record<string, any>,
  next: Record<string, any>
): Record<string, any> {
  const patch: Record<string, any> = {}
  for (const key of PARTNER_PATCH_FIELDS) {
    if (key in next && !eq(prev?.[key], next[key])) patch[key] = next[key]
  }
  if (next.restore === true) patch.restore = true
  return patch
}

export type UpdatePartnerDeps = {
  // Current rows — read at call time so the diff baseline is the LIVE row,
  // not a stale closure.
  getPartners: () => any[]
  // Apply a row into state (both the optimistic write and the revert).
  applyRow: (row: any) => void
  // Failure surface — the App toast. { kind:'error', msg }.
  setToast: (t: { kind: string; msg: string }) => void
  fetchImpl?: typeof fetch
}

export type UpdatePartnerResult =
  | { ok: true; saved: any; noop?: boolean }
  | { ok: false; error: string }

export function makeUpdatePartner(deps: UpdatePartnerDeps) {
  const doFetch = deps.fetchImpl || fetch
  return async function updatePartner(updated: any): Promise<UpdatePartnerResult> {
    const prev = deps.getPartners().find((p) => p?.id === updated?.id)

    // Optimistic apply — the UI answers instantly either way.
    deps.applyRow(updated)

    // Local-only rows (no server uuid — a create that itself failed over to
    // local state) have nothing to PATCH; keep the old behavior for them.
    const isUuid = typeof updated?.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(updated.id)
    if (!isUuid) return { ok: true, saved: updated, noop: true }

    const patch = prev ? computePartnerPatch(prev, updated) : computePartnerPatch({}, updated)
    if (Object.keys(patch).length === 0) return { ok: true, saved: updated, noop: true }

    try {
      const res = await doFetch(`/api/partners/${updated.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
      // Server row is authoritative — reconcile so a concurrent edit the
      // server already absorbed isn't silently shadowed by our snapshot.
      if (json?.id) deps.applyRow(json)
      return { ok: true, saved: json?.id ? json : updated }
    } catch (e: any) {
      const msg = String(e?.message || e)
      // Revert to the pre-edit row so the screen never LIES about a save.
      if (prev) deps.applyRow(prev)
      deps.setToast({ kind: 'error', msg: `Couldn't save ${updated?.name || 'partner'}: ${msg}` })
      return { ok: false, error: msg }
    }
  }
}
