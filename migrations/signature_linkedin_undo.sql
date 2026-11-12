-- migrations/signature_linkedin_undo.sql
-- Reverses signature_linkedin.sql. Personal LinkedIn links disappear from
-- signatures; every location's own LinkedIn is untouched.
alter table public.hub_users drop column if exists signature_linkedin_url;
