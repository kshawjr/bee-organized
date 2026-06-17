-- Backfill corporate_sponsorship_*_at for existing locations.
-- Kevin runs this once after deploy. Future invites are populated
-- by the invite-owner route automatically.

-- prepaid_corporate: started_at unknown → use created_at; ends_at = paid_through_date
UPDATE locations
SET corporate_sponsorship_started_at = created_at,
    corporate_sponsorship_ends_at = paid_through_date
WHERE payment_source = 'prepaid_corporate'
  AND corporate_sponsorship_started_at IS NULL;

-- corporate_sponsored: started_at unknown → use created_at; no fixed end date
UPDATE locations
SET corporate_sponsorship_started_at = created_at,
    corporate_sponsorship_ends_at = NULL
WHERE payment_source = 'corporate_sponsored'
  AND corporate_sponsorship_started_at IS NULL;
