-- ============================================================================
-- BrgyServe — SAMPLE DATA: starter document types.
-- Requires migration 004 (is_active). Fees are placeholders — set the real
-- amounts with the Secretary's Document Types screen or update here first.
-- ============================================================================

INSERT INTO document_types (name, description, fee) VALUES
    ('Barangay Clearance',
     'General-purpose clearance certifying the resident has no derogatory record in the barangay. Commonly required for employment, loans, and permits.',
     50.00),
    ('Certificate of Residency',
     'Certifies that the person is a bona fide resident of Barangay Ubujan.',
     50.00),
    ('Certificate of Indigency',
     'Certifies that the resident belongs to an indigent household, for availing government assistance. Typically issued free of charge.',
     0.00),
    ('Business Clearance',
     'Barangay-level clearance required to operate a business within Barangay Ubujan.',
     200.00);
