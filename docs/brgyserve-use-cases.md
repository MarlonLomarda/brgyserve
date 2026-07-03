# BrgyServe — Use Case & Role Reference

Behavioral reference for building BrgyServe features, distilled from the Chapter 3
Analysis section. Pair this with `brgyserve-database-schema.md` (the data model).
This file defines *who can do what*; the schema file defines *where the data lives*.

Terminology note: the highest official is the **Punong Barangay** (not "Barangay
Captain"). Use "Punong Barangay" consistently.

## Canonical role values

Use these exact strings for the `users.role` column so the app stays consistent:

| Role (thesis) | `role` value | Access level |
|---|---|---|
| Barangay Secretary (System Administrator) | `secretary` | Highest — full admin + records custodian |
| Punong Barangay | `punong_barangay` | Approving authority (view + approve only) |
| Barangay Treasurer | `treasurer` | Financial officer |
| Barangay Staff | `staff` | Front-line processing |
| Barangay Resident | `resident` | End-user (self-registers) |

---

## Actors

- **Barangay Secretary (Administrator)** — System Administrator and records custodian; highest access. Manages all user accounts, maintains resident records (including attendance and dispute records), reviews/certifies documents for endorsement, manages rental schedules, creates events, generates administrative reports.
- **Punong Barangay** — Highest approving authority; participation limited to viewing and approving. Reviews endorsed document requests, approves/declines requests needing a signature, gives final approval on rentals and events, views reports.
- **Barangay Treasurer** — Financial officer. Records/verifies payments for document requests and rentals, issues receipts, generates financial and collection reports.
- **Barangay Staff** — Front-line personnel. Receive/process document requests, verify requester info against resident records, prepare documents, process rentals, help disseminate event announcements.
- **Barangay Resident** — Primary end-user. Self-registers, submits and tracks document requests, books facilities, views events, views their own resident record, settles fees.

All actors share one common function: managing their own account (log in, update profile, change password).

---

## The seven use cases

### 1. Manage Account
Controlled access and full account lifecycle. The Secretary creates the accounts of the Punong Barangay, Treasurer, and Staff, issuing temporary credentials that require a password change on first login, and may activate, deactivate, and reset accounts. Residents enter through self-registration, providing personal information for verification against the resident records, after which they log in, complete their profile, and maintain their account. Every actor can manage their own account; **account administration functions are exclusive to the Secretary.** The Punong Barangay's participation here is limited to maintaining their own login credentials.

### 2. Manage Document Request
Full flow from submission to release. The Resident logs in and submits a request (document type, e.g. Barangay Clearance / Certificate of Residency / Certificate of Indigency / Business Clearance; purpose; supporting requirements). Staff receive it, verify the requester against resident records, prepare and verify the request record, update status, and record issuance/release details (triggers SMS). The Secretary reviews/certifies the prepared document and endorses it to the Punong Barangay. The Punong Barangay approves or declines; the decision reflects in the status (SMS to resident). Once approved and payment is confirmed (via Manage Payment), the document is released. The resident tracks real-time status throughout.

### 3. Manage Resident Record
Maintenance of the official master list of residents. The **Secretary** (records custodian) may add, update, and archive resident profiles, including attendance and dispute records. **Staff** have view-only access for verifying requester info. The **Resident** has view-only access strictly to their *own* resident record — they can view and verify the accuracy of their personal information, with no access to other residents' records. This use case is the central identity reference for the whole system.

### 4. Manage Facility Rental
The Resident views the availability calendar of rentable items/facilities (court, cottage, panel board, costume, tent, chair, table) and submits a request (date, time, purpose, quantity for countable items). Staff confirm the item is offered and enough units are free for that slot after existing bookings, then process it. The Secretary manages the schedule and endorses the booking; the Punong Barangay gives final approval. The resident is notified by SMS; rental fees are recorded/verified via Manage Payment.

### 5. Manage Events and Activities
The Secretary creates and schedules events (general assemblies, medical missions, clean-up drives, sports) and submits them to the Punong Barangay for approval. The Punong Barangay approves or declines before publication. Once approved, Staff encode supporting details and help disseminate announcements (including SMS). Residents view the calendar of approved events and confirm attendance when applicable. Attendance flows into the resident records via Manage Resident Record.

### 6. Manage Payment and Transactions
The Treasurer records and verifies payments for document requests and rentals, issues/records official receipt details, and updates payment status (triggers SMS confirmation). The Resident views applicable fees, settles payments, and views transaction history. Only requests/bookings with verified payments proceed to release or confirmation.

### 7. Generate Report
The Secretary generates administrative reports (document request summaries, resident statistics, facility utilization, event participation). The Treasurer generates financial and collection reports. The Punong Barangay views reports/dashboards read-only. Reports can be reviewed in-system and exported.

---

## Role capability summary

**Barangay Secretary (Administrator)**
- Log in securely; manage own credentials and profile.
- Create, approve, deactivate, and reset user accounts; assign roles.
- Review, certify, and endorse prepared documents for Punong Barangay approval.
- Manage resident records (add, update, archive) including attendance and dispute records.
- Manage facility rental schedules; endorse bookings for final approval.
- Create and schedule events; publish upon approval.
- Generate administrative reports.

**Punong Barangay**
- Log in securely; manage own credentials and profile.
- View document requests endorsed by the Secretary with supporting details.
- Approve or decline requests requiring a signature (decision reflects in status + SMS).
- Give final approval on endorsed rental requests.
- Approve or decline proposed events before publication.
- View system-generated reports and dashboards.

**Barangay Treasurer**
- Log in securely; manage own credentials and profile.
- Record and verify payments for document requests and rentals.
- Issue or record official receipt details.
- Update payment statuses (triggers SMS confirmations).
- Generate financial and collection reports.

**Barangay Staff**
- Log in securely; manage own credentials and profile.
- View and process incoming document requests; verify requester info against resident records.
- Prepare/verify request records; record issuance and release details; endorse for Secretary review.
- Update request statuses (triggers SMS).
- Receive/process rental requests; check schedule conflicts.
- Encode event details; assist in announcement dissemination.

**Barangay Resident**
- Register, log in securely; manage own credentials and profile.
- Submit document requests online (with purpose and supporting requirements).
- Track real-time status; receive SMS at every status update.
- View facility availability; submit rental requests.
- View approved events; receive announcements; confirm attendance.
- View their own resident record and verify its accuracy.
- View applicable fees, settle payments, view transaction history.

---

## Authentication & account rules (for the auth build)

These are the concrete rules the login/registration feature must enforce, taken from Use Case 1:

**Staff-type accounts (secretary, punong_barangay, treasurer, staff):**
- Created *only by the Secretary* — there is no public sign-up for these roles.
- Issued temporary credentials with `must_change_password = true`.
- On first login, the user is forced to set a new password before doing anything else; set `must_change_password = false` after.
- The Secretary can activate, deactivate (`is_active`), and reset these accounts.

**Resident accounts:**
- Created via public self-registration.
- On sign-up, the resident provides personal information that is verified against the `resident_records` table before the account is considered valid.
- After verification, they log in, complete their profile, and maintain their account.

**Common to all roles:**
- Log in, update profile information, change password.
- Account administration (creating/deactivating/resetting *other* accounts, assigning roles) is exclusive to the Secretary.
- The Punong Barangay's account role in this use case is limited to maintaining their own login credentials.

**Implementation notes:**
- Store only `password_hash` (bcrypt) — never plaintext passwords.
- Use `email_verified` for the resident self-registration email check.
- Use `role` (canonical values above) to drive access control on every protected route.
- Access control must be enforced on the **backend** (Express routes), not just hidden in the frontend UI — hiding a button is not security.

⚠ **Open design point — resident ↔ resident_record link.** The current schema has no column tying a resident's user account (`users`/`profiles`) to their row in `resident_records`. This link is needed both for verifying a resident at sign-up and for letting a resident view "their own" resident record (Use Case 3). Decide how to store it — a common approach is a nullable `resident_id` foreign key on `profiles` (or `users`) that is set once the account is verified against a resident record. Resolve this before or during the resident-account build.