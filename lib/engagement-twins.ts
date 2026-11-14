// lib/engagement-twins.ts
// ─────────────────────────────────────────────────────────────
// Server side of the two-open-cards flag (the rule and the words live in
// components/hive/shared/twinCards.js — read that first).
//
// This file only GATHERS: every card the client has, and for the open ones,
// whether each holds a quote, a job or an invoice and when the first of those
// arrived. READS ONLY — nothing here writes. Two callers:
//   · GET  /api/engagements/:id            — the flag the card shows
//   · POST /api/engagements/:id/close-duplicate — the same answer, asked again
//     by the server before it closes anything.
//
// Cost: one engagements read; three small child reads only when the client
// has two or more open cards (60 clients in production on 13 Nov 2026).
// ─────────────────────────────────────────────────────────────
import { supabaseService } from '@/lib/supabase-service'
import { findTwinCard } from '@/components/hive/shared/twinCards'

export type TwinCard = {
  id: string
  client_id: string
  title: string | null
  stage: string
  created_at: string | null
  founded_by: string | null
  location_uuid: string | null
  total_invoiced: number | null
  work: 'invoice' | 'job' | 'quote' | null
  first_work_at: string | null
}

const TERMINAL = ['Closed Won', 'Closed Lost']
const WORK_TABLES = [['quotes', 'quote'], ['jobs', 'job'], ['invoices', 'invoice']] as const
const RANK = { quote: 1, job: 2, invoice: 3 } as const

// Every card this client has, with the work facts filled in for the open
// ones. Throws on a database error: a caller that is about to CLOSE a card
// must never read "no rows" out of a failed query.
export async function loadClientCardsForTwin(clientId: string): Promise<TwinCard[]> {
  const { data, error } = await supabaseService
    .from('engagements')
    .select('id, client_id, title, stage, created_at, founded_by, location_uuid, total_invoiced')
    .eq('client_id', clientId)
  if (error) throw new Error(`engagements read: ${error.message}`)
  const cards: TwinCard[] = ((data || []) as any[]).map(e => ({ ...e, work: null, first_work_at: null }))
  const open = cards.filter(c => !TERMINAL.includes(c.stage))
  if (open.length < 2) return cards

  const ids = open.map(c => c.id)
  const byId = new Map(open.map(c => [c.id, c]))
  for (const [table, kind] of WORK_TABLES) {
    const { data: rows, error: rErr } = await supabaseService
      .from(table)
      .select('engagement_id, created_at')
      .in('engagement_id', ids)
    if (rErr) throw new Error(`${table} read: ${rErr.message}`)
    for (const r of (rows || []) as any[]) {
      const card = byId.get(r.engagement_id)
      if (!card) continue
      if (!card.work || RANK[kind] > RANK[card.work]) card.work = kind
      if (r.created_at && (!card.first_work_at || String(r.created_at) < card.first_work_at)) {
        card.first_work_at = String(r.created_at)
      }
    }
  }
  return cards
}

// The flag for one card, or null. `stage` lets the GET pass the stage it is
// about to show (panel-open drift recovery can move it) without a re-read.
export async function loadTwinForEngagement(engagement: { id: string; client_id: string; stage?: string }) {
  const cards = await loadClientCardsForTwin(engagement.client_id)
  const adjusted = engagement.stage
    ? cards.map(c => (c.id === engagement.id ? { ...c, stage: engagement.stage as string } : c))
    : cards
  return findTwinCard(adjusted, engagement.id)
}
