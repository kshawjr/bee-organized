// app/api/import/jobber-invoice-items/route.ts
// ─────────────────────────────────────────────────────────────
// Fetches line items for all stored invoices.
// Run after the main import to populate line_items JSONB.
// Separate from main import to avoid Jobber complexity limits.
// Critical for royalty calculation — services vs products.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server'
import { getValidJobberToken, jobberQuery } from '@/lib/jobber'
import { getZohoLocation, getZohoToken } from '@/lib/zoho'
import { supabaseService } from '@/lib/supabase-service'
import { writeSyncLog } from '@/lib/sync-log'

// Jobs with invoice line items — focused query, minimal nesting
const INVOICE_LINE_ITEMS_QUERY = `
  query GetInvoiceLineItems($after: String) {
    invoices(first: 50, after: $after) {
      nodes {
        id
        lineItems {
          nodes {
            name
            description
            quantity
            unitPrice
            totalPrice
            taxable
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

export async function POST(req: NextRequest) {
  try {
    const { location_id, mode = 'full' } = await req.json()
    if (!location_id) return NextResponse.json({ error: 'location_id required' }, { status: 400 })

    const location = await getZohoLocation(location_id)
    if (!location) return NextResponse.json({ error: `Location ${location_id} not found` }, { status: 404 })
    if (!location.Jobber_Access_Token) return NextResponse.json({ error: 'Location not connected to Jobber' }, { status: 400 })

    const zohoToken   = await getZohoToken()
    const jobberToken = await getValidJobberToken(location, zohoToken)

    // Get all Jobber job IDs we have stored for this location
    const { data: storedJobs } = await supabaseService
      .from('jobs')
      .select('id, jobber_job_id')
      .eq('location_id', location_id)
      .not('jobber_job_id', 'is', null)

    if (!storedJobs?.length) {
      return NextResponse.json({ success: true, message: 'No jobs found for this location', invoices_updated: 0 })
    }

    // Get all stored invoices for this location
    const { data: storedInvoices } = await supabaseService
      .from('invoices')
      .select('id, jobber_invoice_id')
      .eq('location_id', location_id)
      .not('jobber_invoice_id', 'is', null)

    const invoiceMap = new Map(storedInvoices?.map(i => [i.jobber_invoice_id, i.id]) || [])

    // Paginate through Jobber jobs fetching their invoice line items
    const stats = { invoices_updated: 0, line_items_total: 0, errors: [] as string[] }
    let cursor:  string | null = null
    let hasMore: boolean       = true
    let pages:   number        = 0

    while (hasMore) {
      const res = await jobberQuery(jobberToken, INVOICE_LINE_ITEMS_QUERY, cursor ? { after: cursor } : {})

      if (res.errors) throw new Error(`Line items query error: ${JSON.stringify(res.errors)}`)

      const page = res.data?.invoices
      if (!page) break

      for (const invoice of page.nodes) {
        // Only process invoices we've already stored
        const supabaseInvoiceId = invoiceMap.get(invoice.id)
        if (!supabaseInvoiceId) continue

        const lineItems = (invoice.lineItems?.nodes || []).map((item: any) => ({
          name:        item.name        || '',
          description: item.description || null,
          quantity:    item.quantity    || 1,
          unit_price:  item.unitPrice   ? parseFloat(item.unitPrice)   : null,
          total_price: item.totalPrice  ? parseFloat(item.totalPrice)  : null,
          taxable:     item.taxable     ?? false,
        }))

        try {
          await supabaseService
            .from('invoices')
            .update({
              line_items:       lineItems,
              jobber_synced_at: new Date().toISOString(),
              updated_at:       new Date().toISOString(),
            })
            .eq('id', supabaseInvoiceId)

          stats.invoices_updated++
          stats.line_items_total += lineItems.length
        } catch (err: any) {
          stats.errors.push(`Invoice ${invoice.id}: ${err.message}`)
        }
      }

      hasMore = page.pageInfo.hasNextPage
      cursor  = page.pageInfo.endCursor
      pages++

      if (mode === 'dev' && pages >= 1) break
      if (hasMore) await new Promise(r => setTimeout(r, 400))
    }

    await writeSyncLog({
      location_id,
      entity_id: location_id,
      status: stats.errors.length > 0 ? 'error' : 'success',
      message: `Invoice line items: updated ${stats.invoices_updated} invoices, ${stats.line_items_total} line items. Errors: ${stats.errors.length}`,
    })

    return NextResponse.json({ success: true, location: location.Name, mode, ...stats })
  } catch (err: any) {
    console.error('[invoice-items import]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}