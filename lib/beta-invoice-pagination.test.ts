// @vitest-environment node
//
// Nested-invoice cap (2026-07-09).
//
// JOBS_QUERY fetched each job's invoices with a bare `invoices(first: 10)`
// and no pageInfo — a job with more than 10 invoices (recurring/installment
// billing; prod has a Portland job sitting exactly at 10) silently dropped
// invoice 11+ from the bulk import: rows never upserted, money missing from
// stage classification and lead roll-ups.
//
// Fix under test:
//   * JOBS_QUERY's nested invoices connection carries pageInfo
//   * JOB_INVOICES_QUERY pages one job's remaining invoices by cursor
//   * drainJobInvoices appends the remainder in place, fail-loud on errors,
//     and is a no-op for jobs whose first page was the whole set
//
// The webhook path is deliberately NOT drained: SINGLE_JOB_QUERY's nested
// invoices are shape-mirroring only (invoice rows arrive per-invoice via
// INVOICE_* topics), so its cap drops nothing.
import { describe, it, expect, vi } from 'vitest'

// jobber-import pulls in supabase-service at module load; none of the
// units under test touch the DB, so a stub client is enough.
vi.mock('@/lib/supabase-service', () => ({ supabaseService: {} }))

import {
  JOBS_QUERY,
  JOB_INVOICES_QUERY,
  drainJobInvoices,
} from '@/lib/jobber-import'

const invoiceNode = (n: number) => ({
  id: `inv-${n}`, createdAt: '2026-01-01', jobberWebUri: null,
  invoiceStatus: 'PAID', amounts: { total: '100.00' },
})

describe('query shapes', () => {
  it('JOBS_QUERY nested invoices connection carries pageInfo', () => {
    const nested = JOBS_QUERY.match(/invoices\(first: \d+\) \{[\s\S]*?\n {8}\}/)
    expect(nested).not.toBeNull()
    expect(nested![0]).toMatch(/pageInfo \{ hasNextPage endCursor \}/)
  })
  it('JOB_INVOICES_QUERY pages by job id + cursor', () => {
    expect(JOB_INVOICES_QUERY).toMatch(/\$id: EncodedId!/)
    expect(JOB_INVOICES_QUERY).toMatch(/\$after: String/)
    expect(JOB_INVOICES_QUERY).toMatch(/invoices\(first: \d+, after: \$after\)/)
    expect(JOB_INVOICES_QUERY).toMatch(/pageInfo \{ hasNextPage endCursor \}/)
  })
})

describe('drainJobInvoices', () => {
  it('appends all remaining pages in place and passes the cursor through', async () => {
    const job = {
      id: 'job-1',
      invoices: {
        nodes: Array.from({ length: 10 }, (_, i) => invoiceNode(i)),
        pageInfo: { hasNextPage: true, endCursor: 'c10' },
      },
    }
    const runQuery = vi.fn()
      .mockResolvedValueOnce({ data: { job: { invoices: {
        nodes: [invoiceNode(10), invoiceNode(11)],
        pageInfo: { hasNextPage: true, endCursor: 'c12' },
      } } } })
      .mockResolvedValueOnce({ data: { job: { invoices: {
        nodes: [invoiceNode(12)],
        pageInfo: { hasNextPage: false, endCursor: 'c13' },
      } } } })

    await drainJobInvoices(runQuery, job)

    expect(job.invoices.nodes.map((n: any) => n.id)).toEqual(
      Array.from({ length: 13 }, (_, i) => `inv-${i}`),
    )
    expect(runQuery).toHaveBeenNthCalledWith(1, JOB_INVOICES_QUERY, { id: 'job-1', after: 'c10' })
    expect(runQuery).toHaveBeenNthCalledWith(2, JOB_INVOICES_QUERY, { id: 'job-1', after: 'c12' })
  })

  it('is a no-op when the first page was the whole set', async () => {
    const runQuery = vi.fn()
    const job = {
      id: 'job-2',
      invoices: { nodes: [invoiceNode(0)], pageInfo: { hasNextPage: false, endCursor: 'c1' } },
    }
    await drainJobInvoices(runQuery, job)
    expect(runQuery).not.toHaveBeenCalled()
    expect(job.invoices.nodes).toHaveLength(1)
  })

  it('tolerates nodes with no pageInfo (old staged shapes / single queries)', async () => {
    const runQuery = vi.fn()
    await drainJobInvoices(runQuery, { id: 'job-3', invoices: { nodes: [] } })
    await drainJobInvoices(runQuery, { id: 'job-4' })
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('throws on GraphQL errors instead of staging a partial set', async () => {
    const job = {
      id: 'job-5',
      invoices: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'c0' } },
    }
    const runQuery = vi.fn().mockResolvedValue({ errors: [{ message: 'boom' }] })
    await expect(drainJobInvoices(runQuery, job)).rejects.toThrow(/job_invoices error/)
  })

  it('stops cleanly if the job vanished mid-drain', async () => {
    const job = {
      id: 'job-6',
      invoices: { nodes: [invoiceNode(0)], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
    }
    const runQuery = vi.fn().mockResolvedValue({ data: { job: null } })
    await drainJobInvoices(runQuery, job)
    expect(job.invoices.nodes).toHaveLength(1)
  })
})
