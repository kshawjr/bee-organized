import { createServerSupabaseClient } from './supabase-server'
import { redirect } from 'next/navigation'

export type HubRole = 'super_admin' | 'admin' | 'owner' | 'manager' | 'lite_user'

export async function requireAuth() {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')
  return user
}

export async function getHubUser() {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
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
  if (!hubUser) redirect('/auth/login')
  return hubUser
}

export function isSuperAdmin(role: string) {
  return role === 'super_admin'
}

export function isAdmin(role: string) {
  return role === 'super_admin' || role === 'admin'
}

export function isLiteUser(role: string) {
  return role === 'lite_user'
}

// True for super_admin / admin / owner / manager — i.e. everyone EXCEPT the
// read-only lite_user. Manager is a real operational role (leads + CRM +
// feedback for their location) but is NOT elevated — keep using isAdmin()
// (super_admin + admin) for corporate-only gates, and the explicit owner
// checks for owner-only config (settings, drips, templates, billing, team).
export function isManagerOrAbove(role: string) {
  return (
    role === 'super_admin' ||
    role === 'admin' ||
    role === 'owner' ||
    role === 'manager'
  )
}

// Check if user can see a specific location
export function canAccessLocation(hubUser: any, locationId: string) {
  if (isAdmin(hubUser.role)) return true // admins see all
  return hubUser.location_id === locationId // owners/lite tied to their location
}

// Check if user can run imports
// Owner-of-location enforcement (must own the location being imported into)
// happens in the import route — this check just gates the role itself.
export function canRunImport(role: string) {
  return role === 'super_admin' || role === 'owner'
}
