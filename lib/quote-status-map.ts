// ─────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH: Jobber quoteStatus enum → local quotes.status.
//
// Consumed by BOTH quote write paths so they can never drift:
//   - upsertQuote (lib/jobber-import.ts) — the bulk import AND the webhook
//     (SINGLE_QUOTE_QUERY) both flow through it.
//   - scripts/backfill-quote-status.mjs — the targeted status backfill.
//
// Kept pure + dependency-free (no imports, no `@/` path aliases) on purpose:
// a plain-node .mjs script can dynamic-import this .ts directly (Node strips
// the types) without dragging in supabase-service / Next path aliases.
//
// Jobber's QuoteStatusTypeEnum values:
//   draft · awaiting_response · changes_requested · approved · converted ·
//   archived
// ─────────────────────────────────────────────────────────────────────────

export type LocalQuoteStatus =
  | 'draft'
  | 'sent'
  | 'approved'
  | 'archived'
  | 'changes_requested'

// Map one Jobber quoteStatus to its local column value.
//   APPROVED / CONVERTED  → 'approved'   (converted = approved-then-jobbed)
//   ARCHIVED              → 'archived'   (Jobber's lost/dead state)
//   CHANGES_REQUESTED     → 'changes_requested'
//   DRAFT                 → 'draft'      (never sent — its own calm state)
//   AWAITING_RESPONSE / absent / anything else → 'sent'
//     (a sent quote awaiting a reply; 'sent' is also the legacy default when
//      a caller supplies no quoteStatus at all.)
export function mapQuoteStatus(quoteStatus: string | null | undefined): LocalQuoteStatus {
  const s = (quoteStatus || '').toUpperCase()
  return s === 'APPROVED' ? 'approved'
       : s === 'CONVERTED' ? 'approved'
       : s === 'ARCHIVED' ? 'archived'
       : s === 'CHANGES_REQUESTED' ? 'changes_requested'
       : s === 'DRAFT' ? 'draft'
       : 'sent'
}

// approved_at is stamped ONLY for a literal APPROVED (not CONVERTED) — the
// long-standing upsertQuote semantics, preserved here so the backfill matches
// the live path exactly.
export function quoteStatusStampsApproval(quoteStatus: string | null | undefined): boolean {
  return (quoteStatus || '').toUpperCase() === 'APPROVED'
}
