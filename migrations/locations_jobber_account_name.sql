-- Display name of the connected Jobber account/business.
-- Captured on OAuth callback so owners can verify they connected
-- the right Jobber workspace in Location settings.

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS jobber_account_name TEXT;
