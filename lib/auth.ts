import { createServerSupabaseClient } from './supabase-server'
import { redirect } from 'next/navigation'

export type HubRole = 'super_admin' | 'admin' | 'owner' | 'lite_user'

export async function requireAuth() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  return user
}

export async function getHubUser() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('*')
    .eq('id', user.id)
    .single()
  return hubUser
}

export async function requireHubUser() {
  const hubUser = await getHubUser()
  if (!hubUser) redirect('/login')
  return hubUser
}

export function isSuperAdmin(role: string) {
  return role === 'super_admin'
}

export function isAdmin(role: string) {
  return role === 'super_admin' || role === 'admin'
}

export function isOwnerOrAbove(role: string) {
  return ['super_admin', 'admin', 'owner'].includes(role)
}

export function isLiteUser(role: string) {
  return role === 'lite_user'
}

// Check if user can see a specific location
export function canAccessLocation(hubUser: any, locationId: string) {
  if (isAdmin(hubUser.role)) return true // admins see all
  return hubUser.location_id === locationId // owners/lite tied to their location
}

// Check if user can run imports
export function canRunImport(role: string) {
  return role === 'super_admin'
}