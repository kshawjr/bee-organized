-- migrations/lead_notes_realtime_rls.sql
--
-- PURPOSE
--   Lets Supabase Realtime deliver lead_notes INSERTs to the browser, so a
--   note one bee writes appears on another bee's open card for the same
--   client. Today neither of them can see the other write: a note touches
--   neither the leads row nor touchpoints, so neither existing channel has an
--   event to carry it.
--
-- TWO THINGS ARE MISSING, AND ONE ALONE DOES NOTHING.
--   Applying half of this file leaves the feature just as dead as before, so
--   do not split it:
--
--   1. public.lead_notes is NOT a member of the supabase_realtime publication.
--      Postgres therefore emits no logical-replication record for it and
--      Realtime has nothing to read. (Verified 2026-09-15.)
--   2. public.lead_notes has RLS ENABLED and ZERO policies — deny-all for any
--      role that does not bypass RLS. Even once the rows replicate, Realtime
--      evaluates visibility AS THE AUTHENTICATED USER before sending, so with
--      no SELECT policy every subscriber is told nothing, forever.
--
--   Nothing is broken in the app today because every server route reads
--   lead_notes through the SERVICE key (supabase-service.ts), which bypasses
--   RLS entirely. Realtime is the first reader that is not the service key.
--   This is the same pair of gaps touchpoints had before
--   migrations/touchpoints_realtime_rls.sql, and the same fix.
--
-- WHY THE POLICY IS DERIVED FROM THE LEAD
--   Same rule as touchpoints: you may see a note exactly when you may see its
--   CLIENT. The lead half of the predicate is a transcription of the existing
--   "franchise sees own leads" policy — same hub_users lookup, same locations
--   slug-join — so the two can only ever agree.
--
--   Unlike touchpoints, there is no looser alternative worth weighing here.
--   Measured on production 2026-09-15, across all 89 notes:
--     · 0 with a location_uuid disagreeing with their lead's
--     · 0 with a null location_uuid
--     · 0 without a lead
--   and lead_notes.lead_id is NOT NULL with an ON DELETE CASCADE foreign key
--   to leads, so a note with no client is not merely absent today but
--   structurally impossible. (touchpoints.lead_id is nullable — that is where
--   its partner-scoped rows come from — which is exactly why its policy had
--   to think about rows no lead authorises. This table cannot have them.)
--
-- SCOPE OF THE GRANT
--   SELECT only, role `authenticated` only. No INSERT/UPDATE/DELETE policy:
--   every write still goes through the service key, exactly as today, and
--   adding write policies would widen the table's surface for no reason.
--   Delivery needs SELECT and nothing else.
--
-- NOT INCLUDED, DELIBERATELY
--   public.lead_contacts has the IDENTICAL shape — absent from the
--   publication, RLS on with zero policies — so a secondary contact added by
--   one person is invisible to another in the same way. It is a clean separate
--   job and Kevin has not asked for it. Left alone on purpose; do not assume
--   this file covered it.
--
-- REVERSIBLE
--   drop policy "sees notes for the leads it can see" on public.lead_notes;
--   alter publication supabase_realtime drop table public.lead_notes;
--   Either one turns live notes off again. Neither can affect the server
--   routes — they bypass RLS and do not read the publication.

-- 1. Replicate the table.
alter publication supabase_realtime add table public.lead_notes;

-- 2. Its first SELECT policy.
create policy "sees notes for the leads it can see"
  on public.lead_notes
  for select
  to authenticated
  using (
    exists (
      select 1
      from hub_users hu
      where hu.id = auth.uid()
        and (
          -- Admins see every note, matching "super_admin sees all leads".
          hu.role = any (array['super_admin'::text, 'admin'::text])
          -- Everyone else sees a note only when its CLIENT is one of theirs,
          -- by the same slug-join "franchise sees own leads" uses.
          or exists (
            select 1
            from leads l
            where l.id = lead_notes.lead_id
              and l.location_id = (
                select loc.slug
                from locations loc
                where (loc.id)::text = hu.location_id
              )
          )
        )
    )
  );
