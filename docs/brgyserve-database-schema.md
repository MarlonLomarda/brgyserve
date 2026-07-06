# BrgyServe — Database Schema Reference

Source of truth for the BrgyServe database, converted from the Chapter 3 data
dictionary into PostgreSQL (Supabase) types. Table numbers match the thesis
Chapter 3 File Structure. Table 19 is a new addition (not yet in the thesis)
required by the fuzzy name-matching research contribution.

## Type conventions (MySQL → PostgreSQL)

The thesis data dictionary uses MySQL-style types. In Supabase/PostgreSQL these map as:

| Thesis type | PostgreSQL type | Notes |
|---|---|---|
| `int(4)` (IDs) | `bigint` | Primary keys auto-generated (`GENERATED ALWAYS AS IDENTITY`). |
| `int(4)` (counts) | `integer` | For quantities, not IDs. |
| `varchar(n)` | `varchar(n)` | Unchanged. |
| `text` | `text` | Unchanged. |
| `decimal(10,2)` | `numeric(10,2)` | For money. |
| `datetime` | `timestamptz` | Timezone-aware. |
| `date` | `date` | Unchanged. |
| `time` | `time` | Unchanged. |
| `boolean` | `boolean` | Unchanged. |
| `json` | `jsonb` | `jsonb` is preferred over `json` in PostgreSQL. |

Key legend: **PK** = primary key, **FK** = foreign key, **PK+FK** = both.

---

## Household & Residents

### TABLE 1. household_records
Stores the official household records of Barangay Ubujan, including address, registration date, and status.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| household_id | bigint | PK | No | Uniquely identifies each household record; auto-generated. |
| address | varchar(255) | | No | Complete residential address of the household. |
| registered_at | timestamptz | | No | Date and time the household was registered. |
| is_active | boolean | | No | Whether the household record is currently active. |

### TABLE 2. household_qr
Stores the QR code token assigned to each household for identification during attendance monitoring.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| qr_id | bigint | PK | No | Uniquely identifies each household QR record. |
| household_id | bigint | FK → household_records | No | Household associated with the QR code. |
| qr_token | text | | No | Unique token encoded within the QR code. |
| is_active | boolean | | No | Whether the QR code is currently active and valid. |

### TABLE 3. household_members
Records the residents belonging to each household, along with their role and membership period.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| membership_id | bigint | PK | No | Uniquely identifies each household membership record. |
| household_id | bigint | FK → household_records | No | Household to which the resident belongs. |
| resident_id | bigint | FK → resident_records | No | Resident who is a member of the household. |
| role | varchar(50) | | No | Resident's role in the household (Head, Spouse, Child, Relative). |
| date_started | date | | No | Date the resident joined the household. |
| date_ended | date | | Yes | Date membership ended; null if currently active. |

### TABLE 4. resident_records
Stores the demographic and personal information of residents registered in Barangay Ubujan.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| resident_id | bigint | PK | No | Uniquely identifies each resident record. |
| first_name | varchar(100) | | No | Resident's given name. |
| middle_name | varchar(100) | | Yes | Resident's middle name. |
| last_name | varchar(100) | | No | Resident's family name or surname. |
| suffix | varchar(20) | | Yes | Name suffix such as Jr., Sr., III. |
| birthdate | date | | Yes | Resident's date of birth. |
| birthplace | varchar(255) | | Yes | Place where the resident was born. |
| address | varchar(255) | | No | Resident's current residential address. |
| sex | varchar(20) | | Yes | Resident's sex. |
| civil_status | varchar(50) | | Yes | Civil status (Single, Married, Widowed). |
| religion | varchar(100) | | Yes | Resident's religious affiliation. |
| educational_attainment | varchar(100) | | Yes | Highest educational level attained. |
| contact_number | varchar(20) | | Yes | Resident's contact number. |
| date_registered | timestamptz | | No | Date and time the resident record was registered. |
| is_archived | boolean | | No | Whether the resident record has been archived. |

---

## Events & Attendance

### TABLE 5. events
Stores details of barangay events and activities, including title, description, schedule, and location.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| event_id | bigint | PK | No | Uniquely identifies each event record. |
| title | varchar(255) | | No | Title or name of the event. |
| description | text | | Yes | Detailed description of the event and its purpose. |
| start_datetime | timestamptz | | No | Scheduled date and time the event begins. |
| end_datetime | timestamptz | | No | Scheduled date and time the event ends. |
| location | varchar(255) | | No | Venue or location where the event takes place. |
| date_created | timestamptz | | No | Date and time the event record was created. |

### TABLE 6. event_attendees
Records which residents attended each barangay event.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| event_attendee_id | bigint | PK | No | Uniquely identifies each attendance record. |
| event_id | bigint | FK → events | No | Event where the attendance is recorded. |
| resident_id | bigint | FK → resident_records | No | Resident who attended the event. |

---

## Disputes (Blotter)

### TABLE 7. dispute_records
Stores records of disputes filed within the barangay, including case number, filing date/time, category, and settlement status.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| dispute_id | bigint | PK | No | Uniquely identifies each dispute record. |
| barangay_case_no | varchar(50) | | No | Official case number assigned by the barangay. |
| time_filed | time | | No | Time the dispute was filed. |
| date_filed | date | | No | Date the dispute was filed. |
| filed_for | varchar(255) | | No | Specific complaint or case type (Unjust Vexation, Theft, Physical Injury). |
| nature_of_case | varchar(20) | | No | Case classification (Criminal, Civil, Others). |
| is_settled | boolean | | No | Whether the dispute has been resolved or settled. |

### TABLE 8. dispute_parties
Stores the parties involved in each dispute and their role, such as complainant or respondent.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| dispute_party_id | bigint | PK | No | Uniquely identifies each dispute party record. |
| dispute_id | bigint | FK → dispute_records | No | Dispute case where the party is involved. |
| resident_id | bigint | FK → resident_records | Yes | Resident record; null if the party is not a registered resident. |
| first_name | varchar(100) | | Yes | First name of the party (used if not a registered resident). |
| last_name | varchar(100) | | Yes | Last name of the party (used if not a registered resident). |
| role | varchar(100) | | No | Role of the party (Complainant, Respondent). |

---

## Users & Accounts

### TABLE 9. users
Stores system user accounts, including login credentials, roles, and account status.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| user_id | bigint | PK | No | Uniquely identifies each user account. |
| username | varchar(100) | | No | Unique username used for system login. |
| password_hash | varchar(255) | | No | Hashed password used for authentication. |
| email | varchar(255) | | No | Email address associated with the account. |
| email_verified | boolean | | No | Whether the user's email has been verified. |
| role | varchar(50) | | No | System role (Secretary, Punong Barangay, Treasurer, Staff, Resident). |
| must_change_password | boolean | | No | Whether the user must change their password on next login. |
| is_active | boolean | | No | Whether the account is active and allowed to access the system. |

### TABLE 10. profiles
Stores additional profile information for system users, such as name, contact number, and profile picture.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| user_id | bigint | PK+FK → users | No | Identifies the user this profile belongs to. |
| first_name | varchar(100) | | Yes | User's first name; optional for resident-type accounts. |
| middle_name | varchar(100) | | Yes | User's middle name; optional for resident-type accounts. |
| last_name | varchar(100) | | Yes | User's last name; optional for resident-type accounts. |
| suffix | varchar(20) | | Yes | Name suffix such as Jr., Sr., III. |
| phone_number | varchar(20) | | Yes | Contact number of the user. |
| profile_pic | varchar(255) | | Yes | URL/path of the user's profile picture. |
| resident_id | bigint | FK → resident_records (UNIQUE) | Yes | Links the account to its resident record; set by the Secretary when approving a resident account. Null for pending/unlinked and for staff accounts. Added in migration 002. |
| birthdate | date | | Yes | Birthdate claimed by the resident at self-registration; used by the Secretary to match against resident_records. Added in migration 002. |
| address | varchar(255) | | Yes | Address claimed by the resident at self-registration; used by the Secretary to match against resident_records. Added in migration 002. |

---

## Documents

### TABLE 11. document_types
Stores the available document types that can be requested, including name, description, and fee.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| document_type_id | bigint | PK | No | Uniquely identifies each document type. |
| name | varchar(100) | | No | Name of the document type (Barangay Clearance, Certificate of Residency). |
| description | text | | Yes | Detailed description of the document's purpose. |
| fee | numeric(10,2) | | No | Cost or processing fee for the document type. |
| is_active | boolean | | No | Whether the type is offered for new requests; false hides it from residents without deleting request/fee history (types are deactivated, never deleted). Defaults to true. Added in migration 004. |

### TABLE 12. document_requests
Stores requests for barangay-issued documents, including document type, requester, intended resident, purpose, status, and fulfillment details.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| request_id | bigint | PK | No | Uniquely identifies each document request. *(Thesis lists this as `reques_id` — corrected to `request_id`.)* |
| document_type_id | bigint | FK → document_types | No | Type of document being requested. |
| requested_by_user_id | bigint | FK → users | No | User who submitted the request. |
| resident_id | bigint | FK → resident_records | No | Resident for whom the document is requested. |
| purpose | text | | No | Reason or intended use of the requested document. |
| status | varchar(50) | | No | Current status (Pending, Under Review, Processing, Ready for Release, Claimed, Rejected). |
| processed_by_user_id | bigint | FK → users | Yes | Staff user who processed the request; null until assigned. |
| claimed_at | timestamptz | | Yes | When the document was claimed/released; null until claimed. |

---

## Rentals

### TABLE 13. rental_items
Stores the barangay-owned items and facilities available for rental, along with availability and inventory details.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| item_id | bigint | PK | No | Uniquely identifies each rentable resource. |
| name | varchar(100) | | No | Name of the item or facility (Chairs, Barangay Hall, Basketball Court). |
| type | varchar(50) | | No | Category of the resource (Facility, Equipment, Furniture). |
| description | text | | Yes | Detailed description of the resource. |
| quantity_total | integer | | No | Total number of units owned. |
| quantity_available | integer | | No | Number of units currently available for rental. |
| is_active | boolean | | No | Whether the resource is available for booking or disabled. |

### TABLE 14. rental_requests
Stores rental and booking requests for barangay items and facilities, including resource, schedule, quantity, purpose, and status.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| request_id | bigint | PK | No | Uniquely identifies each rental request. |
| item_id | bigint | FK → rental_items | No | Rented item or facility. |
| requested_by_user_id | bigint | FK → users | No | User who submitted the rental request. |
| quantity_requested | integer | | No | Number of units requested (typically 1 for facilities). |
| start_datetime | timestamptz | | No | Start date and time of the rental period. |
| end_datetime | timestamptz | | No | End date and time of the rental period. |
| purpose | text | | No | Intended use or reason for the rental request. |
| status | varchar(50) | | No | Current status (Pending, Approved, Rejected, Cancelled). |
| processed_by_user_id | bigint | FK → users | Yes | Staff user who processed the request; null until assigned. |

---

## Finance

### TABLE 15. charges
Stores all financial charges within the barangay, including fines, document fees, and rental fees.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| charge_id | bigint | PK | No | Uniquely identifies each charge record. |
| charge_type | varchar(50) | | No | Type of charge (FINE, DOCUMENT, RENTAL). |
| amount | numeric(10,2) | | No | Total amount to be paid for the charge. |
| status | varchar(50) | | No | Current payment status (UNPAID, PAID, VOID). |
| household_id | bigint | FK → household_records | Yes | Household responsible (mainly for fines); null for user-based transactions. |
| user_id | bigint | FK → users | Yes | User who created/requested the transaction; null for system-generated charges. |
| event_id | bigint | FK → events | Yes | Event associated with the charge (for attendance-rule fines); nullable. |
| document_request_id | bigint | FK → document_requests | Yes | Related document request; nullable. |
| rental_request_id | bigint | FK → rental_requests | Yes | Related rental request; nullable. |
| created_at | timestamptz | | No | When the charge was created. |

### TABLE 16. payments
Stores payment transactions for charges, including amount paid, payment method, reference details, and the staff member who processed it.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| payment_id | bigint | PK | No | Uniquely identifies each payment transaction. |
| charge_id | bigint | FK → charges | No | Charge being paid. |
| amount | numeric(10,2) | | No | Amount paid for the charge. |
| payment_method | varchar(20) | | No | Method of payment (Online, Onsite). |
| reference_no | varchar(100) | | Yes | Reference number for the transaction (receipt number or gateway ID). |
| received_by_user_id | bigint | FK → users | Yes | Staff user who recorded the payment; null for online automated payments. |
| created_at | timestamptz | | No | When the payment was recorded. |

---

## System

### TABLE 17. notifications
Stores notifications sent to users or households via SMS or email, including delivery status, content, and related records.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| notification_id | bigint | PK | No | Uniquely identifies each notification record. |
| type | varchar(20) | | No | Type of notification (SMS, EMAIL). |
| user_id | bigint | FK → users | Yes | User recipient; null if sent to a household. |
| household_id | bigint | FK → household_records | Yes | Household recipient; null if sent to a specific user. |
| destination | varchar(255) | | No | Target contact address (phone number or email). |
| subject | varchar(255) | | Yes | Subject line (mainly for email); null for SMS. |
| message | text | | No | Content/body of the notification. |
| status | varchar(50) | | No | Delivery status (PENDING, SENT, FAILED). |
| provider_response | text | | Yes | Response from the SMS/email provider (message ID, error details). |
| related_type | varchar(50) | | Yes | Type of related record (CHARGE, EVENT, DOCUMENT_REQUEST, RENTAL_REQUEST). |
| related_to | bigint | | Yes | ID of the related record (polymorphic — not an enforced FK). |
| created_at | timestamptz | | No | When the notification was created. |
| sent_at | timestamptz | | Yes | When the notification was successfully sent; null until sent. |

### TABLE 18. activity_logs
Stores system audit logs of user actions, including what was changed, where, and the before-and-after values.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| log_id | bigint | PK | No | Uniquely identifies each activity log entry. |
| user_id | bigint | FK → users | No | User who performed the action. |
| action | varchar(100) | | No | Type of action (CREATE, UPDATE, DELETE, LOGIN, APPROVE). |
| table_name | varchar(100) | | No | Name of the database table affected. |
| record_id | bigint | | Yes | ID of the specific record affected (polymorphic — not an enforced FK). |
| old_value | jsonb | | Yes | Previous state of the record; null for CREATE actions. |
| new_value | jsonb | | Yes | New state of the record; null for DELETE actions. |
| timestamp | timestamptz | | No | When the action was performed. |

---

## Research Contribution (NEW — not yet in the thesis)

### TABLE 19. resident_duplicate_candidates
Stores pairs of resident records flagged by the two-stage fuzzy name-matching component as possible duplicates, together with the reviewer's decision. This table is what makes the fuzzy-matching contribution auditable and gives the precision/recall/F1 evaluation something to measure against.

| Field | Type | Key | Nullable | Description |
|---|---|---|---|---|
| candidate_id | bigint | PK | No | Uniquely identifies each flagged duplicate-candidate pair. |
| resident_id_a | bigint | FK → resident_records | No | First resident record in the compared pair. |
| resident_id_b | bigint | FK → resident_records | No | Second resident record in the compared pair. |
| similarity_score | numeric(5,4) | | No | Jaro-Winkler similarity score for the pair (0.0000–1.0000). |
| match_status | varchar(20) | | No | Review outcome: `pending`, `confirmed_duplicate`, or `not_duplicate`. Defaults to `pending`. |
| reviewed_by_user_id | bigint | FK → users | Yes | Staff user who reviewed the pair; null until reviewed. |
| reviewed_at | timestamptz | | Yes | When the pair was reviewed; null until reviewed. |
| created_at | timestamptz | | No | When the matcher flagged the pair. |

**Suggested constraints (tell Claude Code to add these):**
- Prevent a record being compared to itself and prevent mirror-duplicate rows: order the pair so `resident_id_a < resident_id_b`, plus a `UNIQUE (resident_id_a, resident_id_b)` constraint.
- Default `match_status` to `pending`; default `created_at` to `now()`.

---

## Notes for the fuzzy-matching component

When Claude Code builds the schema, also have it set up the pieces the matcher relies on:

1. **Enable the trigram extension:** `CREATE EXTENSION IF NOT EXISTS pg_trgm;`
2. **Add GIN trigram indexes** on the resident name columns used for candidate blocking, e.g. on `resident_records.first_name` and `resident_records.last_name` using `gin_trgm_ops`. These make the pg_trgm similarity filter (Stage 1 blocking) fast.
3. **Jaro-Winkler runs in the application layer** (Node.js), not in PostgreSQL — PostgreSQL's `fuzzystrmatch` does not include Jaro-Winkler. Stage 1 (pg_trgm) narrows the candidate pairs in the database; Stage 2 (Jaro-Winkler scoring) runs in your backend and writes qualifying pairs into `resident_duplicate_candidates`.
