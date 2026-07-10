-- Add a nullable `contract` column to rates.
-- Only internal "Upload Rates" (recordRatesService.buildRate) writes it, for contract
-- forwarders whose rates we key in ourselves. Blank/NULL for everyone else; forwarders
-- submitting through the Submit Rates page never set it.
-- Run via `supabase db push`, or paste into the Supabase SQL editor.

alter table rates add column if not exists contract text;
