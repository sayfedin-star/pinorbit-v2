-- Migration: Set default discovery_max_pages to 500 in pa_workspace_settings
ALTER TABLE pa_workspace_settings
ALTER COLUMN discovery_max_pages SET DEFAULT 500;
