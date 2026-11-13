-- ═════════════════════════════════════════════════════════════════════════════
-- SEED THE FIVE BEE ORGANIZED CALL SCRIPTS        (Settings slice 5, 2026-11-13)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- KEVIN RUNS THIS. No agent has run it and no agent should.
--
-- WHAT IT DOES
--   Adds five rows to `templates`, type 'call', with no location — which is
--   what makes a template one of Bee Organized's own ("master"): every
--   location sees it, and only corporate can change it. It is how the master
--   email templates already work. The five are the scripts on the Call
--   scripts page of the Lovable design, word for word:
--       New lead callback · Past client check-in · Realtor partnership intro
--       · Quote follow-up · Senior move & downsizing
--
-- WHAT IT DOES NOT DO
--   · It changes no table. There are no new columns: a script's "when to
--     use", rough length and stages are plain text inside `body`, read by
--     lib/call-script.ts (which says why).
--   · It touches no existing row. The one call script already in the table
--     ('t8', "Call Prompt Script", switched off since the Gen 1 quarantine)
--     is left exactly as it is: still switched off, still not shown to
--     anyone. To bring it back, switch it on (is_active = true) and it will
--     show on the page as a script with one unnamed stage; to be rid of it,
--     delete it. Neither is done here.
--   · It sends nothing and schedules nothing. A call script is never sent.
--
-- THE {{BRACES}} IN THESE SCRIPTS ARE NOT MERGE TAGS. They are blanks the
-- person on the call fills in by speaking. Some look like merge tags
-- ({{first_name}}, {{owner_name}}); most are not ({{project}},
-- {{agent_name}}, {{city}}, {{date}}, {{loved_one}}). Bee Hub never fills
-- any of them in.
--
-- SAFE TO RUN TWICE. Each row carries a legacy_id, and legacy_id is unique
-- (master_templates_legacy_id_key), so a second run adds nothing. That also
-- means a master a corporate user has since reworded is NOT put back.
--
-- BEFORE YOU RUN IT — look first. This reads only; it should return no rows.
-- If it returns any, those ids are taken and the insert will skip them:
--
--   select legacy_id, name, type, is_active, location_uuid
--   from public.templates
--   where legacy_id in ('call_new_lead_callback', 'call_past_client_check_in', 'call_realtor_partnership_intro', 'call_quote_follow_up', 'call_senior_move_downsizing');
--
-- AFTER YOU RUN IT — the statement itself returns the rows it added (five,
-- the first time). To see what every owner will now see:
--
--   select legacy_id, name, is_active, length(body) as body_chars
--   from public.templates
--   where type = 'call' and location_uuid is null
--   order by name;
--   -- six rows: these five (is_active true) and t8 (is_active false).
--
-- TO UNDO: migrations/seed_call_script_masters_undo.sql
--
-- One statement, on purpose: the Supabase editor can lose what sits between
-- statements, and one statement either adds all five or none.

insert into public.templates (legacy_id, name, type, tag, subject, body, is_active, location_uuid)
values
  ('call_new_lead_callback', 'New lead callback', 'call', 'call', null, $cs$When to use: Within 5 minutes of a website lead
About: 4 min

## Open
Hi {{first_name}}, this is {{owner_name}} with Bee Organized — you just reached out on our website, so I wanted to call while it's fresh. Is now a good time?

## Discover
Tell me a little about the space. What's bugging you most about it right now?

## Value
That's exactly what we do every day. We'll sort, edit, and set up systems so it stays that way — and we haul off donations for you.

## Close
The next step is a quick assessment. I have Tuesday at 10 or Thursday at 2 — which works better?$cs$, true, null),

  ('call_past_client_check_in', 'Past client check-in', 'call', 'call', null, $cs$When to use: 6–12 months after a finished job
About: 3 min

## Open
Hi {{first_name}}! It's {{owner_name}} from Bee Organized. I was thinking about your {{project}} and wanted to see how it's holding up.

## Discover
Is there another room that's been on your mind — garage, closets, the kitchen?

## Offer
Returning clients get first pick of our calendar this season, and a refresh session is a great way to reset.

## Close
Want me to pencil you in for a quick walk-through?$cs$, true, null),

  ('call_realtor_partnership_intro', 'Realtor partnership intro', 'call', 'call', null, $cs$When to use: Cold call to local agents
About: 3 min

## Open
Hi, is this {{agent_name}}? I'm {{owner_name}}, I own Bee Organized here in {{city}}. Got 60 seconds?

## Value
We help sellers declutter and stage-ready their homes, and help buyers unpack and settle in fast. Agents tell us it shortens time on market.

## Offer
I'd love to offer your clients a closing gift — a gift card toward an organizing session, co-branded with you.

## Close
Could I drop off a few cards and our info at your office this week?$cs$, true, null),

  ('call_quote_follow_up', 'Quote follow-up', 'call', 'call', null, $cs$When to use: 3 days after sending an estimate
About: 2 min

## Open
Hi {{first_name}}, {{owner_name}} here from Bee Organized. I'm following up on the plan I sent for your {{project}}.

## Discover
Did you have any questions, or is there anything you'd change?

## Handle
If budget is the concern, we can start with the one space that would make the biggest difference and go from there.

## Close
I'm holding a spot on {{date}} for you — shall I lock it in?$cs$, true, null),

  ('call_senior_move_downsizing', 'Senior move & downsizing', 'call', 'call', null, $cs$When to use: Leads from families or senior communities
About: 5 min

## Open
Hi, this is {{owner_name}} with Bee Organized. I understand you're helping {{loved_one}} with a move — that's a big job, and we're here to make it easier.

## Discover
What's the timeline, and is the new place smaller than the current home?

## Value
We plan the layout of the new space, help decide what comes along, and handle donations, family keepsakes, and setup — so move-in day feels like home.

## Close
Would it help if I came by for a free consultation with you both?$cs$, true, null)

on conflict (legacy_id) do nothing
returning legacy_id, name;
