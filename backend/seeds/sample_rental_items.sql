-- ============================================================================
-- BrgyServe — SAMPLE DATA: starter rental items.
-- Requires migration 009 (fee). Fees are placeholders (per unit per booking) —
-- set the real amounts with the Secretary's Rental Items screen or update
-- here first. quantity_available mirrors quantity_total (see CLAUDE.md,
-- Facility Rentals stage 1).
-- ============================================================================

INSERT INTO rental_items (name, type, description, quantity_total, quantity_available, fee, is_active) VALUES
    ('Basketball Court', 'facility',
     'Covered barangay basketball court. Booked as a whole for games, practices, and community events.',
     1, 1, 500.00, true),
    ('Barangay Hall', 'facility',
     'Multi-purpose hall for meetings, seminars, and private functions such as birthdays and reunions.',
     1, 1, 1500.00, true),
    ('Tent', 'equipment',
     'Collapsible event tent (approx. 3m x 3m), commonly rented for wakes, fiestas, and outdoor gatherings.',
     5, 5, 300.00, true),
    ('Plastic Chairs', 'furniture',
     'Stackable monobloc chairs. Fee is per chair per booking.',
     100, 100, 5.00, true),
    ('Tables', 'furniture',
     'Folding rectangular tables seating 6-8. Fee is per table per booking.',
     20, 20, 25.00, true);
