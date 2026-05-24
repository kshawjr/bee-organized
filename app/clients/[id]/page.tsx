import HubPage from '../../_hub-page'

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return <HubPage initialRoute="clients" initialSelectedLeadId={id} />
}
