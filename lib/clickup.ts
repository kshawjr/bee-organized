// lib/clickup.ts
//
// The ClickUp REST client Bee Desk uses — the only module that talks to
// api.clickup.com. Everything above it (lib/clickup-sync) takes a ClickUpClient
// as an argument, so tests hand it a fake and nothing in the suite can reach
// the live API.
//
// ─── ENV ──────────────────────────────────────────────────────────────
//   CLICKUP_API_TOKEN       a ClickUp personal API token (pk_…), sent as the
//                           raw Authorization header (ClickUp's format — no
//                           "Bearer"). ClickUp tokens are not scoped; a token
//                           acts as the user who made it, so that user must be
//                           able to see and create tasks on list
//                           CLICKUP_BEE_DESK_LIST_ID and read its custom
//                           fields. Make it from a user who can do no
//                           more than that if one exists.
//   CLICKUP_WEBHOOK_SECRET  the `secret` ClickUp returns when the webhook is
//                           registered. ClickUp signs every delivery with it
//                           (X-Signature = hex HMAC-SHA256 of the raw body).
//
// Without CLICKUP_API_TOKEN, clickUpClientFromEnv returns null and every caller
// logs that to sync_log rather than skipping quietly.

import { createHmac, timingSafeEqual } from 'crypto'

export const CLICKUP_BEE_DESK_LIST_ID = '901111225249'

const API = 'https://api.clickup.com/api/v2'

export interface ClickUpFieldOption { id: string; name: string; orderindex?: number }
export interface ClickUpField {
  id: string
  name: string
  type: string
  type_config?: { options?: ClickUpFieldOption[] }
  value?: unknown
}
export interface ClickUpTask {
  id: string
  name?: string
  status?: { status?: string }
  custom_fields?: ClickUpField[]
}

export interface ClickUpClient {
  listFields(listId: string): Promise<ClickUpField[]>
  createTask(listId: string, body: Record<string, unknown>): Promise<{ id: string }>
  getTask(taskId: string): Promise<ClickUpTask>
}

export function clickUpClientFromEnv(): ClickUpClient | null {
  const token = process.env.CLICKUP_API_TOKEN
  if (!token) return null

  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      cache: 'no-store',
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`clickup ${init?.method || 'GET'} ${path} → ${res.status}: ${text.slice(0, 200)}`)
    return text ? JSON.parse(text) : {}
  }

  return {
    listFields: async (listId) => (await call(`/list/${listId}/field`)).fields ?? [],
    createTask: async (listId, body) =>
      call(`/list/${listId}/task`, { method: 'POST', body: JSON.stringify(body) }),
    getTask: async (taskId) => call(`/task/${taskId}`),
  }
}

// X-Signature check, timing-safe. False when the secret is unset — every
// delivery is refused, the same fail-closed stance as the Jobber receiver.
export function verifyClickUpSignature(rawBody: string, signature: string | null | undefined): boolean {
  const secret = process.env.CLICKUP_WEBHOOK_SECRET
  if (!secret) {
    console.error('[clickup-webhook] CLICKUP_WEBHOOK_SECRET not set — refusing all webhooks')
    return false
  }
  if (!signature) return false
  const computed = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const a = Buffer.from(computed, 'utf8')
  const b = Buffer.from(signature.trim().toLowerCase(), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}
