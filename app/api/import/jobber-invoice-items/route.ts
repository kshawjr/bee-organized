// app/api/import/jobber-invoice-items/route.ts
// Fetches invoice line items via jobs → invoices → lineItems
// (root-level invoices query not supported by Jobber)

import { NextRequest, NextResponse } from 'next/server'
import { getValidJobberToken, jobberQuery } from '@/lib/jobber'
import { getZohoLocation, getZohoToken } from '@/lib/zoho'
import { supabaseService } from '@/lib/supabase-service'
import { writeSyncLog } from '@/lib/sync-log'

const JOB_INVOICE_ITEMS_QUERY = `
  query GetJobInvoiceItems($after: String) {
    jobs(first: 50, after: $after) {
      nodes {
        id
        invoices(first: 10) {
          nodes {
            id
            lineItems {
              nodes {
                name
                quantity
                unitPrice
                totalPrice
                taxable
              }
            }
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

    // Get stored invoices for this location to match against
    const { data: storedInvoices } = await supabaseService
      .from('invoices')
      .select('id, jobber_invoice_id')
      .eq('location_id', location_id)
      .not('jobber_invoice_id', 'is', null)

    if (!storedInvoices?.length) {
      return NextResponse.json({ success: true, message: 'No invoices stored for this location', invoices_updated: 0 })
    }

    const invoiceMap = new Map(storedInvoices.map(i => [i.jobber_invoice_id, i.id]))

    const stats = { invoices_updated: 0, line_items_total: 0, errors: [] as string[] }
    let cursor:  string | null = null
    let hasMore: boolean       = true
    let pages:   number        = 0

    while (hasMore) {
      const res = await jobberQuery(jobberToken, JOB_INVOICE_ITEMS_QUERY, cursor ? { after: cursor } : {})
      if (res.errors) throw new Error(`Query error: ${JSON.stringify(res.errors)}`)

      const page = res.data?.jobs
      if (!page) break

      for (const job of page.nodes) {
        for (const invoice of (job.invoices?.nodes || [])) {
          const supabaseId = invoiceMap.get(invoice.id)
          if (!supabaseId) continue

          const lineItems = (invoice.lineItems?.nodes || []).map((item: any) => ({
            name:        item.name       || '',
            quantity:    item.quantity   || 1,
            unit_price:  item.unitPrice  ? parseFloat(item.unitPrice)  : null,
            total_price: item.totalPrice ? parseFloat(item.totalPrice) : null,
            taxable:     item.taxable    ?? false,
          }))

          await supabaseService.from('invoices').update({
            line_items:       lineItems,
            jobber_synced_at: new Date().toISOString(),
            updated_at:       new Date().toISOString(),
          }).eq('id', supabaseId)

          stats.invoices_updated++
          stats.line_items_total += lineItems.length
        }
      }

      hasMore = page.pageInfo.hasNextPage
      cursor  = page.pageInfo.endCursor
      pages++

      if (mode === 'dev' && pages >= 1) break
      if (hasMore) await new Promise(r => setTimeout(r, 400))
    }

    await writeSyncLog({
      location_id, entity_id: location_id,
      status: stats.errors.length > 0 ? 'error' : 'success',
      message: `Line items: ${stats.invoices_updated} invoices updated, ${stats.line_items_total} items. Errors: ${stats.errors.length}`,
    })

    return NextResponse.json({ success: true, location: location.Name, mode, ...stats })
  } catch (err: any) {
    console.error('[invoice-items]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}