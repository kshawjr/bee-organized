-- migrations/lead_contacts_realtime_rls.sql
--
-- PURPOSE
--   Lets Supabase Realtime deliver lead_contacts INSERTs to the browser, so a
--   secondary contact one bee adds appears on another bee's open card for the
--   same client. Today neither of them can see the other add one.
--
-- TWO THINGS ARE MISSING, AND ONE ALONE DOES NOTHING.
--   Applying half of this file leaves the feature just as dead as before, so
--   do not split it:
--
--   1. public.lead_contacts is NOT a member of the supabase_realtime
--      publication. Postgres emits no logical-replication record for it and
--      Realtime has nothing to read. (Verified 2026-09-15.)
--   2. public.lead_contacts has RLS ENABLED and ZERO policies — deny-all for
--      any role that does not bypass RLS. Even once the rows replicate,
--      Realtime evaluates visibility AS THE AUTHENTICATED USER before
--      sending, so with no SELECT policy every subscriber is told nothing.
--
--   Nothing is broken in the app today because every server route reads
--   lead_contacts through the SERVICE key (supabase-service.ts), which
--   bypasses RLS entirely. Realtime is the first reader that is not. This is
--   the identical pair of gaps touchpoints and lead_notes each had, and the
--   identical fix — see migrations/lead_notes_realtime_rls.sql.
--
-- WHY THE POLICY IS DERIVED FROM THE LEAD
--   Same rule as the other two: you may see a contact exactly when you may
--   see its CLIENT. The lead half of the predicate is a transcription of the
--   existing "franchise sees own leads" policy — same hub_users lookup, same
--   locations slug-join — so the two can only ever agree.
--
--   As with lead_notes, there is no looser alternative worth weighing.
--   Measured on production 2026-09-15, across all 7 contacts:
--     · 0 with a location_uuid disagreeing with their lead's
--     · 0 without a lead
--   and lead_contacts.lead_id is NOT NULL with an ON DELETE CASCADE foreign
--   key to leads, so a contact with no client is not merely absent today but
--   structurally impossible. (touchpoints.lead_id is nullable — that is where
--   its partner-scoped rows come from — which is why its policy had to think
--   about rows no lead authorises. This table cannot have them.)
--
-- SCOPE OF THE GRANT
--   SELECT only, role `authenticated` only. No INSERT/UPDATE/DELETE policy:
--   every write still goes through the service key, exactly as today, and
--   adding write policies would widen the table's surface for no reason.
--   Delivery needs SELECT and nothing else.
--
-- WHAT THIS DOES NOT COVER
--   INSERT only, matching lib/use-lead-contacts-realtime.ts. Another user
--   EDITING or REMOVING a contact still needs a reload: the card's merge is
--   additive-by-id and has no defined behaviour for a row that changed or
--   vanished. Deliberate, and better said out loud than half-built.
--
-- REVERSIBLE
--   drop policy "sees contacts for the leads it can see" on public.lead_contacts;
--   alter publication supabase_realtime drop table public.lead_contacts;
--   Either one turns live contacts off again. Neither can affect the server
--   routes — they bypass RLS and do not read the publication.

-- 1. Replicate the table.
alter publication supabase_realtime add table public.lead_contacts;

-- 2. Its first SELECT policy.
create policy "sees contacts for the leads it can see"
  on public.lead_contacts
  for select
  to authenticated
  using (
    exists (
      select 1
      from hub_users hu
      where hu.id = auth.uid()
        and (
          -- Admins see every contact, matching "super_admin sees all leads".
          hu.role = any (array['super_admin'::text, 'admin'::text])
          -- Everyone else sees a contact only when its CLIENT is one of
          -- theirs, by the same slug-join "franchise sees own leads" uses.
          or exists (
            select 1
            from leads l
            where l.id = lead_contacts.lead_id
              and l.location_id = (
                select loc.slug
                from locations loc
                where (loc.id)::text = hu.location_id
              )
          )
        )
    )
  );
