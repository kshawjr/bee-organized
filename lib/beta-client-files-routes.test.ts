// @vitest-environment node
//
// CLIENT FILES — the server (13 Nov 2026). Rules: lib/client-files.ts.
//
// These are photographs of the inside of clients' homes. What is pinned here:
//
//   · A READ-ONLY user cannot add or remove, and the SERVER says no to a
//     forged request — a lite_user, and an owner whose location is paused.
//     "Says no" means: a 403, and nothing reached Storage or the table.
//   · Someone at ANOTHER LOCATION cannot read a file: not by its id, not by
//     its Storage path (no route takes a path), not by listing the client.
//   · Access follows where the client is filed NOW, not where they were.
//   · NOTHING LANDS IN A PUBLIC BUCKET: the one bucket is created private,
//     gets no Storage policy, is re-checked before every upload, and no code
//     here can mint a public or signed link.
//   · A file is what its BYTES say it is; the name is cleaned of traversal.
//   · Permanently deleting a client removes their files from Storage — and
//     only once the client is really gone.
//
// The stand-in database below keeps real rows and applies real .eq() filters,
// so "the other location's row" is genuinely a different row, not a seed that
// happens to say no.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, any[]>,
    objects: new Map<string, { bytes: Uint8Array; contentType: string; bucket: string }>(),
    bucket: { public: false } as { public: boolean } | null,
    removed: [] as string[][],
    fail: {} as Record<string, any>, // 'insert:client_files' | 'delete:leads' | 'select:client_files' | 'upload' → error
    storageCalls: [] as string[],
    order: [] as string[],
    seq: 0,
  }
  const reset = () => {
    state.tables = {}; state.objects = new Map(); state.bucket = { public: false }
    state.removed = []; state.fail = {}; state.storageCalls = []; state.order = []; state.seq = 0
  }
  const from = (table: string) => {
    const filters: [string, any][] = []
    let op: 'select' | 'insert' | 'delete' = 'select'
    let payload: any = null
    const rows = () => (state.tables[table] ||= [])
    const match = (r: any) => filters.every(([c, v]) => r[c] === v)
    const run = (single: boolean) => {
      const err = state.fail[`${op}:${table}`]
      if (err) return { data: null, error: err }
      if (op === 'insert') {
        const row = { id: `00000000-0000-4000-8000-${String(++state.seq).padStart(12, '0')}`, created_at: '2026-11-13T12:00:00Z', ...payload }
        rows().push(row); state.order.push(`insert:${table}`)
        return { data: single ? row : [row], error: null }
      }
      if (op === 'delete') {
        state.tables[table] = rows().filter(r => !match(r)); state.order.push(`delete:${table}`)
        return { data: null, error: null }
      }
      const found = rows().filter(match)
      return { data: single ? (found[0] ?? null) : found, error: null }
    }
    const b: any = {}
    b.select = () => b
    b.order = () => b
    b.eq = (c: string, v: any) => { filters.push([c, v]); return b }
    b.insert = (p: any) => { op = 'insert'; payload = p; return b }
    b.delete = () => { op = 'delete'; return b }
    b.single = () => Promise.resolve(run(true))
    b.maybeSingle = () => Promise.resolve(run(true))
    b.then = (res: any, rej: any) => Promise.resolve(run(false)).then(res, rej)
    return b
  }
  const storage = {
    getBucket: async (id: string) => {
      state.storageCalls.push(`getBucket:${id}`)
      return state.bucket ? { data: { id, public: state.bucket.public }, error: null } : { data: null, error: { message: 'Bucket not found' } }
    },
    from: (bucket: string) => ({
      upload: async (path: string, bytes: Uint8Array, opts: any) => {
        state.storageCalls.push(`upload:${bucket}`)
        if (state.fail.upload) return { data: null, error: state.fail.upload }
        state.objects.set(path, { bytes, contentType: opts?.contentType, bucket }); state.order.push('upload')
        return { data: { path }, error: null }
      },
      download: async (path: string) => {
        state.storageCalls.push(`download:${bucket}`)
        const o = state.objects.get(path)
        return o ? { data: new Blob([o.bytes as any]), error: null } : { data: null, error: { message: 'not found' } }
      },
      remove: async (paths: string[]) => {
        state.storageCalls.push(`remove:${bucket}`)
        state.removed.push(paths); state.order.push('storage-remove')
        for (const p of paths) state.objects.delete(p)
        return { data: [], error: null }
      },
      // Present on the real client. If any route ever calls one, the test
      // below that reads storageCalls goes red.
      createSignedUrl: async () => { state.storageCalls.push('createSignedUrl'); return { data: { signedUrl: 'https://x' }, error: null } },
      getPublicUrl: () => { state.storageCalls.push('getPublicUrl'); return { data: { publicUrl: 'https://x' } } },
    }),
  }
  return { state, reset, from, storage }
})

const authUser = vi.hoisted(() => ({ current: { id: 'owner-sea' } as any }))

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.from(t), storage: h.storage } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authUser.current } })) },
    from: (t: string) => h.from(t),
  })),
}))

// The client route's other imports, stubbed as its own tests stub them
// (lib/beta-address-writeback.test.ts): none of them is on the DELETE path.
vi.mock('@/lib/dual-write', () => ({ updateLead: vi.fn(async () => {}) }))
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: vi.fn(async () => {}) }))
vi.mock('@/lib/drip-send', () => ({ sendDripStep: vi.fn(async () => {}) }))
vi.mock('@/lib/people-mapper', () => ({ mapLeadToPerson: vi.fn(() => ({})) }))
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: vi.fn(), jobberMutation: vi.fn() }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import { GET as LIST, POST as UPLOAD } from '@/app/api/client-files/route'
import { GET as SERVE, DELETE as REMOVE } from '@/app/api/client-files/[id]/route'
import { DELETE as DELETE_LEAD } from '@/app/api/leads/[id]/route'

const SEA = '11111111-1111-4111-8111-111111111111' // Seattle
const KC = '22222222-2222-4222-8222-222222222222'  // Kansas City
const PAUSED = '33333333-3333-4333-8333-333333333333'
const LEAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'       // a Seattle client
const LEAD_PAUSED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ENG = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const ENG_OTHER = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

const PEOPLE = [
  { id: 'owner-sea', role: 'owner', location_id: SEA, full_name: 'Suzanne Allbee' },
  { id: 'mgr-sea', role: 'manager', location_id: SEA, full_name: 'Mia Manager' },
  { id: 'lite-sea', role: 'lite_user', location_id: SEA, full_name: 'Lee Lite' },
  { id: 'owner-kc', role: 'owner', location_id: KC, full_name: 'Kay Cee' },
  { id: 'owner-paused', role: 'owner', location_id: PAUSED, full_name: 'Pat Paused' },
  { id: 'corp', role: 'admin', location_id: null, full_name: 'Leslie Mullins' },
]

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1])
const PDF = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n1 0 obj\n')
const HTML = new TextEncoder().encode('<!doctype html><script>alert(1)</script>')

const as = (id: string) => { authUser.current = { id } }
let formWasRead = false // did the route open the upload at all?
const files = () => h.state.tables.client_files || []

const upload = async (opts: { bytes?: Uint8Array; name?: string; type?: string; lead?: string; engagement?: string; thumb?: Uint8Array } = {}) => {
  const form = new FormData()
  form.append('lead_id', opts.lead ?? LEAD)
  if (opts.engagement) form.append('engagement_id', opts.engagement)
  form.append('file', new File([(opts.bytes ?? JPEG) as any], opts.name ?? 'garage before.jpg', { type: opts.type ?? 'image/jpeg' }))
  if (opts.thumb) form.append('thumb', new File([opts.thumb as any], 'preview.jpg', { type: 'image/jpeg' }))
  formWasRead = false
  const res = await UPLOAD({ formData: async () => { formWasRead = true; return form } } as any)
  return { status: res.status, body: await res.json() }
}
const serve = async (id: string, qs = '', headers: Record<string, string> = {}) =>
  SERVE({ url: `https://hub.test/api/client-files/${id}${qs}`, headers: new Headers(headers) } as any, { params: { id } })
const remove = async (id: string) => {
  const res = await REMOVE({} as any, { params: { id } })
  return { status: res.status, body: await res.json() }
}
const list = async (lead = LEAD, engagement?: string) => {
  const res = await LIST({ url: `https://hub.test/api/client-files?lead_id=${lead}${engagement ? `&engagement_id=${engagement}` : ''}` } as any)
  return { status: res.status, body: await res.json() }
}
/** Seed one stored file on the Seattle client, as if `by` had added it. */
const seedFile = (by = 'owner-sea', over: any = {}) => {
  const id = `99999999-9999-4999-8999-${String(files().length + 1).padStart(12, '0')}`
  const path = `${over.lead_id ?? LEAD}/${id}-photo.jpg`
  h.state.objects.set(path, { bytes: JPEG, contentType: 'image/jpeg', bucket: 'client-files' })
  ;(h.state.tables.client_files ||= []).push({
    id, lead_id: LEAD, engagement_id: null, path, thumb_path: null, name: 'photo.jpg', mime_type: 'image/jpeg',
    size_bytes: JPEG.length, uploaded_by: by, uploaded_by_label: 'Someone', created_at: '2026-11-12T10:00:00Z', ...over,
  })
  return { id, path }
}

beforeEach(() => {
  h.reset()
  as('owner-sea')
  h.state.tables.hub_users = PEOPLE.map(p => ({ ...p }))
  h.state.tables.leads = [
    { id: LEAD, location_uuid: SEA, is_junk: false },
    { id: LEAD_PAUSED, location_uuid: PAUSED, is_junk: false },
  ]
  h.state.tables.locations = [
    { id: SEA, lifecycle_status: 'active', subscription_status: 'active' },
    { id: KC, lifecycle_status: 'active', subscription_status: 'active' },
    { id: PAUSED, lifecycle_status: 'paused', subscription_status: 'active' },
  ]
  h.state.tables.engagements = [{ id: ENG, client_id: LEAD }, { id: ENG_OTHER, client_id: LEAD_PAUSED }]
  h.state.tables.client_files = []
})

describe('adding a file', () => {
  it('an owner adds a photo: filed under the CLIENT in the private bucket, with a row saying who', async () => {
    const r = await upload()
    expect(r.status).toBe(201)
    expect(files()).toHaveLength(1)
    const row = files()[0]
    expect(row.path.startsWith(`${LEAD}/`)).toBe(true)
    expect(row.path).not.toContain('owner-sea')
    expect(row.path).not.toContain(SEA)
    expect(row).toMatchObject({ lead_id: LEAD, engagement_id: null, name: 'garage before.jpg', mime_type: 'image/jpeg', uploaded_by: 'owner-sea', uploaded_by_label: 'Suzanne Allbee' })
    expect(h.state.objects.get(row.path)!.bucket).toBe('client-files')
    // the browser is never told where the object is
    expect(JSON.stringify(r.body)).not.toContain(row.path)
    expect(r.body.file).toMatchObject({ id: row.id, name: 'garage before.jpg', can_remove: true, has_preview: false })
  })

  it('a manager may add; corporate may add at any location', async () => {
    as('mgr-sea'); expect((await upload()).status).toBe(201)
    as('corp'); expect((await upload()).status).toBe(201)
    expect(files()).toHaveLength(2)
  })

  it('a file added on a job is pinned to that job — and only a job that is THIS client’s', async () => {
    expect((await upload({ engagement: ENG })).status).toBe(201)
    expect(files()[0].engagement_id).toBe(ENG)
    const wrong = await upload({ engagement: ENG_OTHER })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error).toBe('engagement_not_on_lead')
    expect(files()).toHaveLength(1)
  })

  it('the type is what the BYTES say: a web page named .jpg, claiming to be a JPEG, is refused and nothing is stored', async () => {
    const r = await upload({ bytes: HTML, name: 'holiday.jpg', type: 'image/jpeg' })
    expect(r.status).toBe(415)
    expect(r.body.detail).toMatch(/Only photos .* and PDFs/)
    expect(h.state.objects.size).toBe(0)
    expect(files()).toHaveLength(0)
  })

  it('a PDF is stored as a PDF even when the browser calls it something else', async () => {
    const r = await upload({ bytes: PDF, name: 'Quote 1042.pdf', type: 'application/octet-stream' })
    expect(r.status).toBe(201)
    expect(files()[0].mime_type).toBe('application/pdf')
    expect(h.state.objects.get(files()[0].path)!.contentType).toBe('application/pdf')
  })

  it('over 4 MB is refused in plain words, and nothing is stored', async () => {
    const big = new Uint8Array(4 * 1024 * 1024 + 1); big.set(JPEG)
    const r = await upload({ bytes: big })
    expect(r.status).toBe(413)
    expect(r.body.detail).toMatch(/over 4 MB/)
    expect(h.state.objects.size).toBe(0)
  })

  it('a name that tries to climb out of the folder is flattened; the shown name is just the name', async () => {
    const r = await upload({ name: '../../../etc/passwd.jpg' })
    expect(r.status).toBe(201)
    const row = files()[0]
    expect(row.path).not.toContain('..')
    expect(row.path.split('/')).toHaveLength(2)
    expect(row.path.endsWith('-passwd.jpg')).toBe(true)
    expect(row.name).toBe('passwd.jpg')
  })

  it('a small JPEG preview is kept beside the file; a preview that is not a JPEG is dropped', async () => {
    await upload({ thumb: JPEG })
    expect(files()[0].thumb_path).toBe(files()[0].path.replace(/-garage_before\.jpg$/, '-preview.jpg'))
    expect(h.state.objects.has(files()[0].thumb_path)).toBe(true)
    await upload({ thumb: HTML })
    expect(files()[1].thumb_path).toBeNull()
  })

  it('if the row cannot be written, the stored object is taken back out — no file without a record', async () => {
    h.state.fail['insert:client_files'] = { code: '23514', message: 'check violated' }
    const r = await upload({ thumb: JPEG })
    expect(r.status).toBe(500)
    expect(h.state.objects.size).toBe(0)
    expect(h.state.removed.flat()).toHaveLength(2)
  })

  it('a client in the bin takes no new files', async () => {
    h.state.tables.leads[0].is_junk = true
    const r = await upload()
    expect(r.status).toBe(409)
    expect(h.state.objects.size).toBe(0)
  })
})

describe('a read-only user cannot add or remove — the SERVER refuses a forged request', () => {
  it('lite_user: a forged upload is a 403 and reaches neither Storage nor the table', async () => {
    as('lite-sea')
    const r = await upload()
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('forbidden_read_only_role')
    expect(h.state.storageCalls).toEqual([])
    expect(files()).toHaveLength(0)
    // turned away on their role alone: the upload itself is never opened
    expect(formWasRead).toBe(false)
  })

  it('lite_user: a forged remove is a 403 and the file is still there', async () => {
    const f = seedFile('lite-sea') // even one recorded as their own
    as('lite-sea')
    const r = await remove(f.id)
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('forbidden_read_only_role')
    expect(files()).toHaveLength(1)
    expect(h.state.objects.has(f.path)).toBe(true)
    expect(h.state.removed).toEqual([])
  })

  it('lite_user can still SEE: the list answers, and says nothing is theirs to remove', async () => {
    seedFile('owner-sea')
    as('lite-sea')
    const r = await list()
    expect(r.status).toBe(200)
    expect(r.body.files).toHaveLength(1)
    expect(r.body.files[0].can_remove).toBe(false)
  })

  it('a PAUSED location’s owner: forged upload and forged remove are both 403, nothing changes', async () => {
    const f = seedFile('owner-paused', { lead_id: LEAD_PAUSED })
    as('owner-paused')
    const up = await upload({ lead: LEAD_PAUSED })
    expect(up.status).toBe(403)
    expect(up.body.error).toBe('forbidden_read_only_location')
    const del = await remove(f.id)
    expect(del.status).toBe(403)
    expect(del.body.error).toBe('forbidden_read_only_location')
    expect(files()).toHaveLength(1)
    expect(h.state.storageCalls).toEqual([])
  })

  it('nobody signed in: 401 on all four doors', async () => {
    const f = seedFile()
    authUser.current = null
    expect((await upload()).status).toBe(401)
    expect((await list()).status).toBe(401)
    expect((await serve(f.id)).status).toBe(401)
    expect((await remove(f.id)).status).toBe(401)
    expect(h.state.storageCalls).toEqual([])
  })
})

describe('someone at another location cannot read a file', () => {
  it('by its id: 403, and the bytes are never fetched', async () => {
    const f = seedFile()
    as('owner-kc')
    const res = await serve(f.id)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_wrong_location')
    expect(h.state.storageCalls).toEqual([])
    expect((await serve(f.id, '?preview=1')).status).toBe(403)
    expect((await serve(f.id, '?download=1')).status).toBe(403)
  })

  it('by its Storage PATH: there is nothing to ask — a path is not a file id', async () => {
    const f = seedFile()
    as('owner-kc')
    for (const guess of [f.path, encodeURIComponent(f.path), `${LEAD}`, '../' + f.path]) {
      const res = await serve(guess)
      expect(res.status).toBe(404)
    }
    expect(h.state.storageCalls).toEqual([])
  })

  it('no route under /api/client-files takes a path, and none can mint a link', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? [p, ...walk(p)] : [p]
    })
    const all = walk('app/api/client-files')
    // exactly two route files: the list/upload, and one file by id
    expect(all.filter(p => p.endsWith('route.ts')).sort()).toEqual(['app/api/client-files/[id]/route.ts', 'app/api/client-files/route.ts'])
    expect(all.some(p => p.includes('[...'))).toBe(false)
    const src = [...all.filter(p => p.endsWith('.ts')), 'lib/client-files.ts', 'lib/client-files-server.ts', 'components/hive/shared/FilesTab.jsx', 'components/hive/shared/photoPrep.js']
      .map(p => readFileSync(p, 'utf8')).join('\n')
    // the calls themselves, not the words (the comments explain why not)
    expect(src).not.toMatch(/\.createSignedUrl\(|\.createSignedUrls\(|\.getPublicUrl\(|\.createSignedUploadUrl\(/)
    expect(src).not.toMatch(/NextResponse\.redirect\(/)
  })

  it('cannot list the client, add to them, or remove from them', async () => {
    const f = seedFile()
    as('owner-kc')
    expect((await list()).status).toBe(403)
    expect((await upload()).status).toBe(403)
    expect((await remove(f.id)).status).toBe(403)
    expect(files()).toHaveLength(1)
    expect(h.state.storageCalls).toEqual([])
  })

  it('access follows where the client is filed NOW: after a move to Kansas City, Seattle is out and KC is in', async () => {
    const f = seedFile('owner-sea')
    as('owner-sea'); expect((await serve(f.id)).status).toBe(200)
    h.state.tables.leads[0].location_uuid = KC // transferred; the file row and its path are untouched
    as('owner-sea'); expect((await serve(f.id)).status).toBe(403)
    as('owner-kc'); expect((await serve(f.id)).status).toBe(200)
    as('owner-kc'); expect((await list()).body.files).toHaveLength(1)
  })

  it('corporate reads at any location', async () => {
    const f = seedFile()
    as('corp')
    expect((await serve(f.id)).status).toBe(200)
  })
})

describe('how a file is served', () => {
  it('the bytes come back from OUR route — no redirect, no link — typed as stored, never cached for others', async () => {
    const f = seedFile('owner-sea', { name: 'Garage – before (1).jpg' })
    const res = await serve(f.id)
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toBe('private, no-cache')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename="Garage_before_1_\.jpg"; filename\*=UTF-8''Garage/)
    expect(h.state.storageCalls).toEqual(['download:client-files'])
  })

  it('"still the one I have?" is answered only after the access check: 304 for Seattle, 403 for Kansas City', async () => {
    const f = seedFile()
    const tag = (await serve(f.id)).headers.get('etag')!
    h.state.storageCalls.length = 0
    expect((await serve(f.id, '', { 'if-none-match': tag })).status).toBe(304)
    expect(h.state.storageCalls).toEqual([])
    as('owner-kc')
    expect((await serve(f.id, '', { 'if-none-match': tag })).status).toBe(403)
  })

  it('?download=1 sends it as a download; a file with no preview has none', async () => {
    const f = seedFile()
    expect((await serve(f.id, '?download=1')).headers.get('content-disposition')).toMatch(/^attachment;/)
    expect((await serve(f.id, '?preview=1')).status).toBe(404)
  })
})

describe('removing a file', () => {
  it('an owner removes any file at their location: the row and the object both go', async () => {
    const f = seedFile('mgr-sea', { thumb_path: `${LEAD}/x-preview.jpg` })
    const r = await remove(f.id)
    expect(r.status).toBe(200)
    expect(files()).toHaveLength(0)
    expect(h.state.removed).toEqual([[f.path, `${LEAD}/x-preview.jpg`]])
    // row first, then Storage
    expect(h.state.order).toEqual(['delete:client_files', 'storage-remove'])
  })

  it('a manager removes what they added, and is refused on someone else’s', async () => {
    const mine = seedFile('mgr-sea')
    const theirs = seedFile('owner-sea')
    as('mgr-sea')
    expect((await remove(mine.id)).status).toBe(200)
    const r = await remove(theirs.id)
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('forbidden_not_yours')
    expect(files().map((f: any) => f.id)).toEqual([theirs.id])
    expect(h.state.objects.has(theirs.path)).toBe(true)
  })

  it('the list tells each person what they may remove', async () => {
    seedFile('mgr-sea'); seedFile('owner-sea')
    as('mgr-sea')
    expect((await list()).body.files.map((f: any) => f.can_remove)).toEqual([true, false])
    as('owner-sea')
    expect((await list()).body.files.map((f: any) => f.can_remove)).toEqual([true, true])
  })
})

describe('the list', () => {
  it('a job’s list is only that job’s files; the client’s list is all of them', async () => {
    seedFile('owner-sea', { engagement_id: ENG }); seedFile('owner-sea')
    expect((await list()).body.files).toHaveLength(2)
    expect((await list(LEAD, ENG)).body.files).toHaveLength(1)
  })

  it('before the migration is run: an empty list that says so, not an error', async () => {
    h.state.fail['select:client_files'] = { code: 'PGRST205', message: "Could not find the table 'public.client_files' in the schema cache" }
    const r = await list()
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ files: [], not_ready: true })
  })

  it('any other database failure is a failure', async () => {
    h.state.fail['select:client_files'] = { code: '57014', message: 'timeout' }
    expect((await list()).status).toBe(500)
  })
})

describe('nothing lands in a public bucket', () => {
  it('every upload names the one bucket, and it is checked to be private first', async () => {
    await upload({ thumb: JPEG })
    expect(h.state.storageCalls).toEqual(['getBucket:client-files', 'upload:client-files', 'upload:client-files'])
    expect(Array.from(h.state.objects.values()).every(o => o.bucket === 'client-files')).toBe(true)
  })

  it('if the bucket has been made PUBLIC, the upload is refused and nothing is stored', async () => {
    h.state.bucket = { public: true }
    const r = await upload()
    expect(r.status).toBe(503)
    expect(r.body.error).toBe('files_bucket_not_private')
    expect(h.state.storageCalls).toEqual(['getBucket:client-files'])
    expect(h.state.objects.size).toBe(0)
    expect(files()).toHaveLength(0)
  })

  it('if the bucket is not there yet, the upload says Files isn’t switched on', async () => {
    h.state.bucket = null
    const r = await upload()
    expect(r.status).toBe(503)
    expect(r.body.detail).toBe('Files isn’t switched on yet.')
    expect(h.state.objects.size).toBe(0)
  })

  it('the migration makes the bucket private (even when re-run), turns row security on, and adds no policy', () => {
    const sql = readFileSync('migrations/client_files.sql', 'utf8')
    const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    expect(code).toMatch(/VALUES \(\s*'client-files', 'client-files', false, 4194304,/)
    expect(code).toMatch(/ON CONFLICT \(id\) DO UPDATE\s+SET public = false,/)
    expect(code).not.toMatch(/public\s*=\s*true|,\s*true\s*,/i)
    expect(code).toMatch(/ALTER TABLE public\.client_files ENABLE ROW LEVEL SECURITY/)
    expect(code).not.toMatch(/create\s+policy/i)
    expect(code).not.toMatch(/\bgrant\b/i)
  })

  it('the code names exactly one bucket, and it is not one of the public ones', () => {
    const lib = readFileSync('lib/client-files.ts', 'utf8')
    expect(lib).toContain("export const CLIENT_FILES_BUCKET = 'client-files'")
    for (const p of ['app/api/client-files/route.ts', 'app/api/client-files/[id]/route.ts', 'lib/client-files-server.ts']) {
      const src = readFileSync(p, 'utf8')
      const named = Array.from(src.matchAll(/storage\s*\.from\(([^)]*)\)/g)).map(m => m[1].trim())
      expect(named.every(n => n === 'CLIENT_FILES_BUCKET'), `${p}: ${named.join(', ')}`).toBe(true)
      expect(src).not.toMatch(/help-media|email-signatures|feedback-attachments/)
    }
  })
})

describe('when a client is permanently deleted', () => {
  const deleteLead = async (id = LEAD) => {
    const res = await DELETE_LEAD({} as any, { params: Promise.resolve({ id }) })
    return { status: res.status, body: await res.json() }
  }

  it('their files are removed from Storage — after the client is really gone', async () => {
    h.state.tables.leads[0].is_junk = true
    const a = seedFile('owner-sea', { thumb_path: `${LEAD}/a-preview.jpg` })
    const b = seedFile('mgr-sea')
    const r = await deleteLead()
    expect(r.status).toBe(200)
    expect(h.state.removed).toEqual([[a.path, `${LEAD}/a-preview.jpg`, b.path]])
    expect(h.state.order).toEqual(['delete:leads', 'storage-remove'])
  })

  it('if the delete is refused, not one file is touched', async () => {
    h.state.tables.leads[0].is_junk = true
    const a = seedFile()
    h.state.fail['delete:leads'] = { code: '23503', message: 'violates foreign key constraint' }
    const r = await deleteLead()
    expect(r.status).toBe(500)
    expect(h.state.removed).toEqual([])
    expect(h.state.objects.has(a.path)).toBe(true)
  })

  it('a client who is not in the bin is not deleted, and their files stay', async () => {
    const a = seedFile()
    expect((await deleteLead()).status).toBe(409)
    expect(h.state.objects.has(a.path)).toBe(true)
    expect(h.state.removed).toEqual([])
  })

  it('a client with no files, or before the migration is run, deletes exactly as before', async () => {
    h.state.tables.leads[0].is_junk = true
    h.state.fail['select:client_files'] = { code: '42P01', message: 'relation "public.client_files" does not exist' }
    expect((await deleteLead()).status).toBe(200)
    expect(h.state.storageCalls).toEqual([])
  })
})
