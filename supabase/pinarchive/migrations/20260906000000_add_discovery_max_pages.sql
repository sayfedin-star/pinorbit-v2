-- Migration: Add discovery_max_pages to pa_workspace_settings
-- Controls max pages scraped per account in a single discovery run (default: 500 pages = ~25,000 pins)

ALTER TABLE pa_workspace_settings
ADD COLUMN IF NOT EXISTS discovery_max_pages integer DEFAULT 500;
