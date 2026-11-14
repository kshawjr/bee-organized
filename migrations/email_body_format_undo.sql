-- migrations/email_body_format_undo.sql
--
-- Undo for migrations/email_body_format.sql.
--
-- READ THIS FIRST. Dropping the column makes every body read as plain text
-- again. That is harmless while every row is 'plain'. It is NOT harmless once
-- the rich-text editor has saved anything: an html body read as plain text
-- reaches the client with its tags showing. Run this check first, and only
-- drop the columns if both counts are 0:
--
--   select 'drip_path_steps' as tbl, count(*) from public.drip_path_steps where body_format = 'html'
--   union all
--   select 'templates', count(*) from public.templates where body_format = 'html';
--
-- Single statement each, safe to re-run.
alter table public.drip_path_steps drop column if exists body_format;
alter table public.templates drop column if exists body_format;
