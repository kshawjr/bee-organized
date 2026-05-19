import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'

// POST /api/lookups/reorder
// Body: { items: [{ id, sort_order }, { id, sort_order }, ...] }
//
// Bulk sort_order update after a drag-reorder in the Configure UI. Client
// computes new sort_order values (e.g. spacing of 10: [10, 20, 30, ...])
// and sends the full list for the affected category.
//
// We don't enforce category consistency here — the client is trusted to
// only send items from one category at a time. If the caller mixes
// categories, the update still works (each row gets its own sort_order),
// it just wouldn't make UX sense.
//
// Write permission: super_admin or admin only.

export async function POST(req: NextRequest) {
  try {
    await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser) {
      return NextResponse.json({ error: 'No hub user profile' }, { status: 403 })
    }
    if (hubUser.role !== 'super_admin' && hubUser.role !== 'admin') {
      return NextResponse.json({ error: 'Only super_admin or admin can manage lookups' }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const items = Array.isArray(body?.items) ? body.items : null
    if (!items || items.length === 0) {
      return NextResponse.json({ error: 'items array is required' }, { status: 400 })
    }

    // Validate shape before issuing any writes.
    for (const it of items) {
      if (!it || typeof it !== 'object') {
        return NextResponse.json({ error: 'Each item must be an object' }, { status: 400 })
      }
      if (typeof it.id !== 'string' || !it.id) {
        return NextResponse.json({ error: 'Each item needs an id' }, { status: 400 })
      }
      if (typeof it.sort_order !== 'number') {
        return NextResponse.json({ error: 'Each item needs a numeric sort_order' }, { status: 400 })
      }
    }

    const now = new Date().toISOString()

    // Run updates in parallel — Supabase's REST API doesn't expose a true
    // bulk-update by varying value, so we issue N updates concurrently.
    // For a typical list (5-20 items) this is fast enough; for huge lists
    // we could batch into a Postgres RPC later.
    const results = await Promise.all(
      items.map((it: { id: string; sort_order: number }) =>
        supabaseService
          .from('lookups')
          .update({ sort_order: it.sort_order, updated_at: now })
          .eq('id', it.id)
          .select('id, sort_order')
          .maybeSingle()
      )
    )

    const failures = results.filter((r) => r.error)
    if (failures.length > 0) {
      console.error('[/api/lookups/reorder] partial failure:', failures.map((f) => f.error?.message))
      return NextResponse.json(
        {
          error: 'Some reorders failed',
          updated: results.filter((r) => !r.error && r.data).length,
          failed: failures.length,
        },
        { status: 500 }
      )
    }

    return NextResponse.json({
      ok: true,
      updated: results.filter((r) => r.data).length,
    })
  } catch (err: any) {
    console.error('[/api/lookups/reorder] error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}
