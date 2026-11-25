// lib/network/mailchimp-send-hub-footprint.ts
// ─────────────────────────────────────────────────────────────
// Mailchimp slice 6 (FL-75, 2026-11-25) changed components/BeeHub.jsx on
// purpose, in the Mailchimp card only: the first-sync confirmation and the
// result line now come from components/settings/MailchimpSyncAnswer.jsx
// (paused flows, held tags, "stopped partway"), and Sync now reads "Check
// again" after a refusal for live flows. Older tests pin BeeHub.jsx by
// fingerprint. They take THIS change back out first, by these exact pieces —
// each must be present exactly once, and the file with all of them put back
// is byte for byte origin/main a8c77c0. So ANY other change still fails them.
//
// [what is there now, what main a8c77c0 had].
// ─────────────────────────────────────────────────────────────

export const MAILCHIMP_SEND_HUB_PIECES: [string, string][] = [
  ["import { SyncConfirm as McSyncConfirm, SyncResult as McSyncResult } from \"@/components/settings/MailchimpSyncAnswer\"\n", ""],
  ["                {syncing ? (syncResult?.reason === 'signup_flows_live' ? 'Checking…' : 'Syncing…') : (syncResult?.reason === 'signup_flows_live' ? 'Check again' : 'Sync now')}\n", "                {syncing ? 'Syncing…' : 'Sync now'}\n"],
  ["            {/* First sync: nothing has been sent; the server is asking (FL-75\n                slice 6: count, audience, the paused flows, held tags). */}\n            {pendingConfirm && (\n              <McSyncConfirm confirm={pendingConfirm} syncing={syncing}\n                onYes={(tagsOk)=>runSync({ count: pendingConfirm.count, list_id: pendingConfirm.list_id, flows: pendingConfirm.flows, tags_ok: tagsOk })}\n                onCancel={()=>setPendingConfirm(null)} />\n            )}\n\n            {syncResult && <McSyncResult result={syncResult} listName={listName} />}\n\n", "            {/* First sync: nothing has been sent; the server is asking. */}\n            {pendingConfirm && (\n              <div style={{ marginTop:'10px', background:HT.state.warning.soft, borderRadius:HT.radius.control, padding:'11px 12px' }}>\n                <p style={{ fontSize:'13px', color:HT.ink.primary, lineHeight:1.6, margin:'0 0 9px' }}>\n                  {firstSyncConfirmCopy(pendingConfirm.count, pendingConfirm.list_name)}\n                </p>\n                <div style={{ display:'flex', gap:'8px', flexWrap:'wrap' }}>\n                  <button onClick={()=>runSync({ count: pendingConfirm.count, list_id: pendingConfirm.list_id })} disabled={syncing} className=\"bee-small-action\"\n                    style={{ padding:'8px 14px', background:HT.accent.fg, border:'none', borderRadius:HT.radius.control, fontFamily:'inherit', fontWeight:700, color:HT.accent.onFill, cursor:syncing?'default':'pointer', opacity:syncing?0.7:1 }}>\n                    {syncing ? 'Syncing…' : `Yes, subscribe ${pendingConfirm.count}`}\n                  </button>\n                  <button onClick={()=>setPendingConfirm(null)} disabled={syncing} className=\"bee-small-action\"\n                    style={{ padding:'8px 14px', background:'transparent', border:HT.border.control, borderRadius:HT.radius.control, fontFamily:'inherit', fontWeight:600, color:HT.ink.secondary, cursor:'pointer' }}>\n                    Cancel\n                  </button>\n                </div>\n              </div>\n            )}\n\n            {syncResult && (\n              <p style={{ fontSize:'12px', color:syncResult.ran?HT.ink.secondary:HT.state.warning.fg, background:syncResult.ran?HT.surface.sunken:HT.state.warning.soft, borderRadius:HT.radius.control, padding:'8px 10px', margin:'8px 0 0', lineHeight:1.5 }}>\n                {syncResult.ran\n                  ? `Pushed ${syncResult.pushed} to Mailchimp · ${syncResult.skipped} skipped · ${syncResult.failed} failed${syncResult.failed > 0 ? ' — failed contacts will be retried on the next sync' : ''}`\n                  : 'Nothing was sent — sending to Mailchimp isn\\u2019t switched on for your location yet.'}\n              </p>\n            )}\n\n"],
]

/** BeeHub.jsx with Mailchimp slice 6 taken back out. Throws if a piece is missing or doubled. */
export function withoutMailchimpSendSlice6(src: string): string {
  let s = src
  for (const [piece, back] of MAILCHIMP_SEND_HUB_PIECES) {
    const n = s.split(piece).length - 1
    if (n !== 1) throw new Error(`BeeHub.jsx: a Mailchimp slice 6 piece ${JSON.stringify(piece.slice(0, 60))} appears ${n} times, expected 1`)
    s = s.split(piece).join(back)
  }
  return s
}
