// lib/dual-write.ts
// ─────────────────────────────────────────────────────────────
// Every write in Bee Hub goes to BOTH Supabase and Zoho.
// This utility enforces that pattern consistently.
//
// RULE: Never write to one without the other during transition.
// Supabase = fast local reads. Zoho = source of truth / fallback.
// ─────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'
import { zohoUpdate, getZohoToken } from '@/lib/zoho'
import { writeSyncLog } from '@/lib/sync-log'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ─── Lead (Hive record) ───────────────────────────────────────

interface LeadPayload {
  // Supabase fields
  location_id: string
  name: string
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  phone?: string | null
  address?: string | null
  stage?: string
  source?: string
  project_type?: string
  assigned_to?: string | null
  jobber_client_id?: string | null
  // Zoho fields (how to write back)
  zoho_lead_id?: string | null    // Zoho Leads module record ID
  zoho_deal_id?: string | null    // Zoho Deals module record ID
  zoho_contact_id?: string | null // Zoho Contacts module record ID
}

export async function createLead(payload: LeadPayload): Promise<{ id: string }> {
  const now = new Date().toISOString()

  // 1. Write to Supabase
  const { data, error } = await supabase
    .from('leads')
    .insert({
      location_id:      payload.location_id,
      name:             payload.name,
      first_name:       payload.first_name || null,
      last_name:        payload.last_name  || null,
      email:            payload.email      || null,
      phone:            payload.phone      || null,
      address:          payload.address    || null,
      stage:            payload.stage      || 'New',
      source:           payload.source     || null,
      project_type:     payload.project_type || null,
      assigned_to:      payload.assigned_to || null,
      jobber_client_id: payload.jobber_client_id || null,
      created_at:       now,
      updated_at:       now,
    })
    .select('id')
    .single()

  if (error) throw new Error(`Supabase createLead failed: ${error.message}`)

  // 2. Write to Zoho (if we have a Zoho record to update)
  await syncLeadToZoho(payload, data.id)

  return { id: data.id }
}

export async function updateLead(
  id: string,
  patch: Partial<LeadPayload>
): Promise<void> {
  // 1. Update Supabase
  const { error } = await supabase
    .from('leads')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw new Error(`Supabase updateLead failed: ${error.message}`)

  // 2. Sync to Zoho
  await syncLeadToZoho(patch as LeadPayload, id)
}

async function syncLeadToZoho(payload: Partial<LeadPayload>, supabaseId: string) {
  try {
    // Map Bee Hub fields → Zoho field names
    const zohoData: Record<string, any> = {
      Hub_Lead_ID: supabaseId,  // stamp our Supabase ID onto Zoho record
    }

    if (payload.stage)            zohoData['Stage']            = payload.stage
    if (payload.source)           zohoData['Lead_Source']      = payload.source
    if (payload.jobber_client_id) zohoData['Jobber_Client_ID'] = payload.jobber_client_id
    if (payload.assigned_to)      zohoData['Owner']            = payload.assigned_to

    // Write to whichever Zoho module we have an ID for
    if (payload.zoho_deal_id) {
      await zohoUpdate('Deals', payload.zoho_deal_id, zohoData)
    }
    if (payload.zoho_lead_id) {
      await zohoUpdate('Leads', payload.zoho_lead_id, zohoData)
    }
    if (payload.zoho_contact_id) {
      await zohoUpdate('Contacts', payload.zoho_contact_id, {
        Hub_Lead_ID:      supabaseId,
        Jobber_Client_ID: payload.jobber_client_id,
      })
    }
  } catch (err: any) {
    // Zoho write failure is non-fatal — log it but don't throw
    console.error('[dual-write] Zoho sync failed:', err.message)
    await writeSyncLog({
      location_id:     payload.location_id || 'unknown',
      entity_id:       supabaseId,
      status:          'error',
      message:         `Zoho write-back failed: ${err.message}`,
    })
  }
}

// ─── Stage Update ─────────────────────────────────────────────
// Most common operation — update stage in both systems

export async function updateLeadStage(
  id: string,
  stage: string,
  zohoIds?: { deal_id?: string; lead_id?: string }
): Promise<void> {
  // Supabase
  await supabase
    .from('leads')
    .update({ stage, updated_at: new Date().toISOString() })
    .eq('id', id)

  // Zoho
  if (zohoIds?.deal_id) {
    await zohoUpdate('Deals', zohoIds.deal_id, { Stage: stage }).catch(err =>
      console.error('[dual-write] Stage update to Zoho failed:', err.message)
    )
  }
}

// ─── Jobber Client Link ───────────────────────────────────────
// Called after import — stamps Jobber client ID onto both systems

export async function linkJobberClient(
  supabaseLeadId: string,
  jobberClientId: string,
  zohoIds?: { contact_id?: string; deal_id?: string }
): Promise<void> {
  // Supabase
  await supabase
    .from('leads')
    .update({ jobber_client_id: jobberClientId, updated_at: new Date().toISOString() })
    .eq('id', supabaseLeadId)

  // Zoho — stamp the Jobber client ID so Zoho knows who maps to whom
  if (zohoIds?.contact_id) {
    await zohoUpdate('Contacts', zohoIds.contact_id, {
      Jobber_Client_ID: jobberClientId,
      Hub_Lead_ID:      supabaseLeadId,
    }).catch(err => console.error('[dual-write] Zoho contact link failed:', err.message))
  }

  if (zohoIds?.deal_id) {
    await zohoUpdate('Deals', zohoIds.deal_id, {
      Jobber_Client_ID: jobberClientId,
      Hub_Lead_ID:      supabaseLeadId,
    }).catch(err => console.error('[dual-write] Zoho deal link failed:', err.message))
  }
}