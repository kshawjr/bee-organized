// lib/help-content.ts
//
// The Help section's shared, side-effect-free rules. Server-safe (no React,
// no 'use client') so the API routes, the screen, and the tests all read ONE
// definition of who may edit, what a row may hold, and how the flat table
// becomes a tree.
//
// THE DATA MODEL, in one paragraph. Sections, topics and items live in ONE
// table (help_entries) told apart by `kind` and linked by `parent_id`. One
// table because the three levels share every operation the editor needs —
// add at the bottom, rename, move up/down, soft-delete, restore — and one
// route per operation is simpler than three. The item-only columns (lead,
// media, steps, callout, draft status) are nullable on the other two kinds
// and guarded by CHECK constraints in migrations/help_entries.sql. The read
// side is one ordered query and a tree build; that same flat, ordered,
// text-first shape is what will let Ask Bee Hub read the content later.

export type HelpKind = 'section' | 'topic' | 'item'
export type HelpMediaKind = 'video' | 'image'
export type HelpStatus = 'draft' | 'published'

export type HelpRow = {
  id: string
  kind: HelpKind
  parent_id: string | null
  position: number
  title: string
  slug?: string | null
  tab_key?: string | null
  icon?: string | null
  lead?: string | null
  media_kind?: HelpMediaKind | null
  media_path?: string | null
  steps?: unknown
  callout?: string | null
  status: HelpStatus
  deleted_at?: string | null
  created_by?: string | null
  updated_by?: string | null
  created_at?: string
  updated_at?: string
}

export type HelpNode = HelpRow & {
  media_url: string | null
  steps: string[]
  children: HelpNode[]
}

// ── who may edit ──────────────────────────────────────────────────
// hub_users.role has no value spelled "corporate": the corp tier is stored as
// 'admin' and the UI labels it Corporate / Corp. These are the DATABASE role
// names; the client-side gate (BeeHub's role==='corporate') is the same two
// people by another name.
export const HELP_EDITOR_ROLES = ['super_admin', 'admin'] as const

export function isHelpEditorRole(role: unknown): boolean {
  return (HELP_EDITOR_ROLES as readonly string[]).includes(String(role ?? ''))
}

// ── media limits ──────────────────────────────────────────────────
// Video: 100 MB and two minutes. A one-minute phone clip lands around
// 20–60 MB after iOS's own re-encode on upload, so the cap leaves room
// without inviting a ten-minute screencast. Image: 10 MB, the same as a
// feedback attachment. The bucket enforces the byte cap a second time.
export const HELP_MEDIA_BUCKET = 'help-media'
export const HELP_VIDEO_MAX_BYTES = 100 * 1024 * 1024
export const HELP_VIDEO_MAX_SECONDS = 120
export const HELP_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const HELP_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const
export const HELP_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

export function mediaKindForType(mime: unknown): HelpMediaKind | null {
  const t = String(mime ?? '').toLowerCase()
  if ((HELP_VIDEO_TYPES as readonly string[]).includes(t)) return 'video'
  if ((HELP_IMAGE_TYPES as readonly string[]).includes(t)) return 'image'
  return null
}

// The one message an over-limit upload produces, in words an editor can act
// on. Returned by the sign route AND shown client-side before any bytes move.
export function mediaLimitProblem(kind: HelpMediaKind, bytes: number, seconds?: number | null): string | null {
  if (kind === 'video') {
    if (bytes > HELP_VIDEO_MAX_BYTES) return 'That video is over 100 MB. Trim it or record a shorter clip — two minutes is the most Help will take.'
    if (seconds != null && Number.isFinite(seconds) && seconds > HELP_VIDEO_MAX_SECONDS) {
      return `That video runs ${Math.round(seconds)} seconds. Help clips stop at two minutes — split it into two items instead.`
    }
    return null
  }
  if (bytes > HELP_IMAGE_MAX_BYTES) return 'That screenshot is over 10 MB. A plain screenshot from a phone is well under that — try again without editing it into a huge file.'
  return null
}

// Public URL for an object in the help-media bucket. Public bucket → a plain
// URL, no signing, no expiry — which is what lets <video> seek and resume.
export function helpMediaUrl(path: string | null | undefined, supabaseUrl?: string): string | null {
  if (!path) return null
  const base = (supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '')
  if (!base) return null
  return `${base}/storage/v1/object/public/${HELP_MEDIA_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`
}

// Object path for a new upload: <kind>/<uuid>.<ext>. Random, so a public URL
// is unguessable; extension kept so the browser and CDN pick the right type.
export function helpMediaPath(kind: HelpMediaKind, mime: string, uuid: string): string {
  const ext: Record<string, string> = {
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  }
  return `${kind}/${uuid}.${ext[mime.toLowerCase()] || 'bin'}`
}

// ── row input, sanitised ──────────────────────────────────────────
// Caps are generous for prose and tight for anything that is a handle. Steps
// arrive as an array of strings OR one string with a step per line (the
// phone form is a single textarea — the least friction at 11pm).
export const HELP_LIMITS = { title: 120, lead: 240, callout: 400, step: 300, steps: 30, icon: 8 } as const

export function normalizeSteps(raw: unknown): string[] {
  let list: unknown[] = []
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === 'string') list = raw.split(/\r?\n/)
  return list
    .map(s => String(s ?? '').trim().replace(/^\s*(?:\d+[.)]|[-•*])\s*/, ''))
    .filter(Boolean)
    .slice(0, HELP_LIMITS.steps)
    .map(s => s.slice(0, HELP_LIMITS.step))
}

export type HelpEntryInput = {
  kind: HelpKind
  parent_id: string | null
  title: string
  icon: string | null
  tab_key: string | null
  lead: string | null
  media_kind: HelpMediaKind | null
  media_path: string | null
  steps: string[]
  callout: string | null
  status: HelpStatus
}

// Returns the clean row or a plain-language problem. Every rule the database
// also enforces is checked here first so the editor gets words, not a
// constraint name.
export function normalizeEntryInput(raw: unknown): { input: HelpEntryInput; problem: null } | { input: null; problem: string } {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const kind = String(src.kind ?? '') as HelpKind
  if (!['section', 'topic', 'item'].includes(kind)) return { input: null, problem: 'kind must be section, topic or item' }
  const title = String(src.title ?? '').trim().slice(0, HELP_LIMITS.title)
  if (!title) return { input: null, problem: 'A title is required.' }
  const parent_id = src.parent_id == null || src.parent_id === '' ? null : String(src.parent_id)
  if (kind === 'section' && parent_id) return { input: null, problem: 'A section has no parent.' }
  if (kind !== 'section' && !parent_id) return { input: null, problem: `A ${kind} needs a parent.` }

  const status: HelpStatus = src.status === 'draft' ? 'draft' : 'published'
  const str = (v: unknown, cap: number) => { const s = String(v ?? '').trim().slice(0, cap); return s || null }

  if (kind !== 'item') {
    return {
      input: {
        kind, parent_id, title,
        icon: kind === 'section' ? str(src.icon, HELP_LIMITS.icon) : null,
        tab_key: kind === 'section' ? str(src.tab_key, 32) : null,
        lead: null, media_kind: null, media_path: null, steps: [], callout: null,
        status: 'published',
      },
      problem: null,
    }
  }

  const media_kind = src.media_kind == null || src.media_kind === '' ? null : String(src.media_kind)
  const media_path = str(src.media_path, 300)
  if (media_kind && !['video', 'image'].includes(media_kind)) return { input: null, problem: 'media_kind must be video or image' }
  if ((media_kind && !media_path) || (!media_kind && media_path)) return { input: null, problem: 'Media needs both a kind and a path.' }
  if (media_path && (media_path.includes('..') || !media_path.startsWith(`${media_kind}/`))) return { input: null, problem: 'invalid media path' }

  return {
    input: {
      kind, parent_id, title, icon: null, tab_key: null,
      lead: str(src.lead, HELP_LIMITS.lead),
      media_kind: media_kind as HelpMediaKind | null,
      media_path,
      steps: normalizeSteps(src.steps),
      callout: str(src.callout, HELP_LIMITS.callout),
      status,
    },
    problem: null,
  }
}

// ── the tree ──────────────────────────────────────────────────────
// rows → nested sections › topics › items, ordered by position at every
// level. Soft-deleted rows are dropped along with everything under them —
// a deleted section takes its topics and items out of sight with it, and
// restoring the section brings them back untouched.
//
// includeDrafts=false is the OWNER view: draft items go, and then any topic
// with no visible items goes, and then any section with no visible topics —
// an owner never meets a heading with nothing under it.
export function buildHelpTree(rows: HelpRow[], opts: { includeDrafts: boolean; supabaseUrl?: string }): HelpNode[] {
  const byParent = new Map<string | null, HelpRow[]>()
  for (const r of rows) {
    if (r.deleted_at) continue
    const key = r.parent_id ?? null
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(r)
  }
  const order = (a: HelpRow, b: HelpRow) => (a.position - b.position) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))

  const build = (parentId: string | null, depth: number): HelpNode[] => {
    const kids = (byParent.get(parentId) ?? []).slice().sort(order)
    const out: HelpNode[] = []
    for (const r of kids) {
      if (r.kind === 'item' && r.status === 'draft' && !opts.includeDrafts) continue
      const node: HelpNode = {
        ...r,
        steps: normalizeSteps(r.steps),
        media_url: helpMediaUrl(r.media_path, opts.supabaseUrl),
        children: r.kind === 'item' ? [] : build(r.id, depth + 1),
      }
      if (!opts.includeDrafts && r.kind !== 'item' && node.children.length === 0) continue
      out.push(node)
    }
    return out
  }
  return build(null, 0)
}

// The ids that soft-deleting `id` hides (itself and every descendant), and
// the top-most deleted rows for the editor's restore list.
export function deletedRoots(rows: HelpRow[]): HelpRow[] {
  const byId = new Map(rows.map(r => [r.id, r]))
  return rows.filter(r => {
    if (!r.deleted_at) return false
    let p = r.parent_id ? byId.get(r.parent_id) : null
    while (p) { if (p.deleted_at) return false; p = p.parent_id ? byId.get(p.parent_id) : null }
    return true
  })
}

// Up/down reorder: given the ordered siblings and the id to move, return the
// pair of {id, position} writes that swap it with its neighbour — or null at
// the edge. Positions are rewritten as 0..n-1 first so two rows that once
// shared a position (a race, an import) come apart cleanly.
export function moveSibling(siblings: HelpRow[], id: string, direction: 'up' | 'down'): Array<{ id: string; position: number }> | null {
  const ordered = siblings.slice().sort((a, b) => a.position - b.position)
  const i = ordered.findIndex(s => s.id === id)
  if (i < 0) return null
  const j = direction === 'up' ? i - 1 : i + 1
  if (j < 0 || j >= ordered.length) return null
  const writes = ordered.map((s, k) => ({ id: s.id, position: k }))
  const tmp = writes[i].position
  writes[i].position = writes[j].position
  writes[j].position = tmp
  return writes
}

// The breadcrumb an ask carries into the feedback form — plain words, no
// ids, so a triage reader sees "Getting started › Connect Jobber" today
// without any change to the triage screen. Ids ride separately in context.
export function helpBreadcrumb(parts: Array<{ title?: string | null } | null | undefined>): string {
  return parts.map(p => String(p?.title ?? '').trim()).filter(Boolean).join(' › ')
}

// Does this PostgREST/Postgres error mean help_entries is not there yet? The
// migration is HELD (Kevin runs it), so the reader degrades to an empty tree
// and the writers say so in words, instead of a 500.
export function isMissingHelpTable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown }
  const code = String(e.code ?? '')
  if (code === 'PGRST205' || code === '42P01' || code === 'PGRST204') return true
  const msg = String(e.message ?? '').toLowerCase()
  return msg.includes('help_entries') && (msg.includes('not find') || msg.includes('does not exist') || msg.includes('schema cache'))
}

export const HELP_NOT_SET_UP = "Help isn't set up yet — the help_entries migration hasn't been run."
