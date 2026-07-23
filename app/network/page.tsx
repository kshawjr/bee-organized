import HubPage from '../_hub-page'

// Network — the canonical URL for the referral-partner tab (Phase 2 rename).
// /contacts remains a permanent alias (app/contacts/page.tsx) so existing
// links and bookmarks keep resolving; both land on the same nav key.
export default function Page() {
  return <HubPage initialRoute="network" />
}
