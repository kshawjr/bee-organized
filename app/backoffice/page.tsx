import HubPage from '../_hub-page'

// issue 140 — Back Office tab. SSR entry so /backoffice hard-refreshes and
// deep links land on the right tab; the render split (super_admin vs everyone)
// lives in BeeHub's screen().
export default function Page() {
  return <HubPage initialRoute="backoffice" />
}
