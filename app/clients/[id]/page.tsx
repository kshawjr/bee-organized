import HubPage from '../../_hub-page'

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ e?: string }>
}) {
  const { id } = await params
  const { e } = await searchParams
  // ?e=<engagementId> deep-links an engagement WITHIN this client. HubPage
  // validates it belongs to the (location-scoped) client before opening — an
  // invalid/foreign id is silently dropped (client opens, engagement doesn't).
  return (
    <HubPage
      initialRoute="clients"
      initialSelectedLeadId={id}
      initialSelectedEngagementId={typeof e === 'string' ? e : undefined}
    />
  )
}
