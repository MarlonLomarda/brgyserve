-- ============================================================================
-- BrgyServe — TEST DATA: seed resident_records for the fuzzy name-matching
-- engine. DO NOT run against a production database.
--
-- 36 realistic Filipino resident records for Barangay Ubujan, including six
-- PLANTED NEAR-DUPLICATE PAIRS (12 rows) for verifying the matcher and for
-- building the labeled evaluation set later. resident_id values are
-- auto-generated, so the planted pairs are identified by name below:
--
--   PAIR 1  abbreviation        : "Maria Elena Santos"      = "Ma. Elena Santos"
--   PAIR 2  misspelled surname  : "Jose Santos"             = "Jose Santoz"
--   PAIR 3  missing given name  : "Juan Miguel Dela Cruz"   = "Juan Dela Cruz" (no middle name)
--   PAIR 4  transposed letters  : "Rodrigo Bautista"        = "Rodirgo Bautista"
--   PAIR 5  dropped double letter: "Anabelle Garcia"        = "Anabele Garcia"
--   PAIR 6  enye/encoding       : "Niño Peñaflor"           = "Nino Penaflor"
--
-- Every pair shares the same birthdate and address (same real person entered
-- twice), which is how such duplicates typically appear in barangay records.
-- ============================================================================

INSERT INTO resident_records
    (first_name, middle_name, last_name, birthdate, address, date_registered, is_archived)
VALUES
    -- ---- PAIR 1: abbreviation (Maria / Ma.) --------------------------------
    ('Maria Elena', 'Villamor',  'Santos',    '1985-03-14', 'Purok 2, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Ma. Elena',   'Villamor',  'Santos',    '1985-03-14', 'Purok 2, Barangay Ubujan, Tagbilaran City', now(), false),

    -- ---- PAIR 2: misspelled surname (Santos / Santoz) ----------------------
    ('Jose',        'Ramirez',   'Santos',    '1978-11-02', 'Purok 5, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Jose',        'Ramirez',   'Santoz',    '1978-11-02', 'Purok 5, Barangay Ubujan, Tagbilaran City', now(), false),

    -- ---- PAIR 3: missing second given name + no middle name ----------------
    ('Juan Miguel', 'Torralba',  'Dela Cruz', '1990-06-08', 'Purok 1, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Juan',        NULL,        'Dela Cruz', '1990-06-08', 'Purok 1, Barangay Ubujan, Tagbilaran City', now(), false),

    -- ---- PAIR 4: transposed letters (Rodrigo / Rodirgo) --------------------
    ('Rodrigo',     'Cempron',   'Bautista',  '1969-01-25', 'Purok 6, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Rodirgo',     'Cempron',   'Bautista',  '1969-01-25', 'Purok 6, Barangay Ubujan, Tagbilaran City', now(), false),

    -- ---- PAIR 5: dropped double letter (Anabelle / Anabele) ----------------
    ('Anabelle',    'Dagohoy',   'Garcia',    '1994-09-30', 'Purok 4, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Anabele',     'Dagohoy',   'Garcia',    '1994-09-30', 'Purok 4, Barangay Ubujan, Tagbilaran City', now(), false),

    -- ---- PAIR 6: enye / encoding inconsistency (ñ vs n) --------------------
    ('Niño',        'Salazar',   'Peñaflor',  '2001-12-16', 'Purok 7, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Nino',        'Salazar',   'Penaflor',  '2001-12-16', 'Purok 7, Barangay Ubujan, Tagbilaran City', now(), false),

    -- ---- Fillers: distinct residents, no planted duplicates ----------------
    ('Carmela',     'Tan',       'Uy',          '1982-07-19', 'Purok 1, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Felipe',      'Adlawan',   'Jumamoy',     '1955-05-01', 'Purok 3, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Rosario',     'Bagotchay', 'Clarin',      '1948-08-27', 'Purok 2, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Andres',      'Villamor',  'Relampagos',  '1975-02-11', 'Purok 6, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Teresita',    'Cabrera',   'Galope',      '1963-10-05', 'Purok 4, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Manuel',      'Dumadag',   'Tirol',       '1958-12-30', 'Purok 5, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Corazon',     'Lagunay',   'Butalid',     '1970-04-22', 'Purok 7, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Ricardo',     'Mendez',    'Sarabia',     '1987-06-15', 'Purok 1, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Lourdes',     'Pacana',    'Bernido',     '1992-01-09', 'Purok 3, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Emilio',      'Ratunil',   'Dagohoy',     '1966-09-17', 'Purok 2, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Consuelo',    'Sabanal',   'Inting',      '1979-03-03', 'Purok 6, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Bienvenido',  'Toribio',   'Bahian',      '1951-11-28', 'Purok 4, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Remedios',    'Verdadero', 'Ramos',       '1984-05-24', 'Purok 5, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Crisanto',    'Wenceslao', 'Aquino',      '1997-07-07', 'Purok 7, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Gemma',       'Ybanez',    'Villanueva',  '1989-10-13', 'Purok 1, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Domingo',     'Zamora',    'Pajo',        '1960-02-02', 'Purok 3, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Marites',     'Alaba',     'Olaivar',     '1993-08-20', 'Purok 2, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Rolando',     'Bongato',   'Bompat',      '1972-12-06', 'Purok 6, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Evangeline',  'Curambao',  'Cabagnot',    '1981-04-18', 'Purok 4, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Norberto',    'Digal',     'Lofranco',    '1956-06-29', 'Purok 5, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Editha',      'Estoque',   'Maglajos',    '1968-01-31', 'Purok 7, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Wilfredo',    'Fuentes',   'Ampoloquio',  '1976-09-08', 'Purok 1, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Perla',       'Gutierrez', 'Tabaranza',   '1990-11-11', 'Purok 3, Barangay Ubujan, Tagbilaran City', now(), false),
    ('Celso',       'Horcerada', 'Doydora',     '1964-03-26', 'Purok 2, Barangay Ubujan, Tagbilaran City', now(), false);
