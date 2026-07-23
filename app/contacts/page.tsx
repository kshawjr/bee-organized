import HubPage from '../_hub-page'

// Permanent ALIAS for /network (the tab's canonical URL since the Phase 2
// rename) — kept so pre-rename links and bookmarks resolve forever. Both
// slugs map to the same nav key in shared/hubUrl.js.
export default function Page() {
  return <HubPage initialRoute="contacts" />
}
