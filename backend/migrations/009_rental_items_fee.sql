-- ============================================================================
-- Migration 009: rental fee on rental_items.
--
-- Facility Rentals stage 1. rental_items had no fee column (Table 13), but
-- rental fees flow through the existing charges/payments system, so each
-- rentable item needs its price. The fee is per UNIT per booking: facilities
-- (court, hall) are single-unit so it reads as a per-booking rate; for
-- countable items (chairs, tables) the rental charge in stage 4 will be
-- fee x quantity_requested.
--
-- DEFAULT 0 keeps the column NOT NULL even if rows already exist; new items
-- always set it explicitly through the API.
--
-- Run manually in the Supabase SQL Editor.
-- ============================================================================

ALTER TABLE rental_items
    ADD COLUMN fee numeric(10,2) NOT NULL DEFAULT 0;
