# BrgyServe

## Project Overview

BrgyServe is a web-based document request and tracking system for **Barangay Ubujan, Tagbilaran City, Bohol**. It is a capstone project that digitizes barangay services: residents request official documents online and track their status, while barangay officials process requests, manage resident records, handle facility rentals and payments, record disputes/blotter entries, and generate reports.

## Tech Stack

- **Frontend:** React (scaffolded with Vite) — `/frontend`
- **Backend:** Node.js with Express — `/backend`
- **Database:** Supabase (PostgreSQL)

## Repository Structure

```
brgyserve/
├── frontend/          # React app (Vite). Dev server: npm run dev (http://localhost:5173)
│   ├── src/
│   │   ├── api/client.js      # fetch wrapper; VITE_API_URL base + Bearer token
│   │   ├── auth/              # AuthContext.jsx (login/logout, localStorage), roles.js (role → route)
│   │   ├── components/        # ProtectedRoute.jsx
│   │   └── pages/             # LoginPage, RegisterPage, RoleLandingPage
│   └── .env.example           # VITE_API_URL (optional, defaults to localhost:5000)
├── backend/           # Express API. Dev server: npm run dev (http://localhost:5000)
│   ├── src/
│   │   ├── server.js          # Express entry point
│   │   ├── config/supabase.js # Supabase client (reads keys from .env)
│   │   ├── middleware/auth.js # JWT authentication + role guard
│   │   └── routes/            # auth.js, secretary.js, residents.js
│   ├── migrations/            # SQL migrations - applied manually via Supabase SQL Editor
│   ├── .env                   # Real credentials - gitignored, never commit
│   └── .env.example           # Template documenting required env vars
└── CLAUDE.md
```

## Commands

- Backend dev server: `cd backend && npm run dev` (nodemon, auto-restart)
- Frontend dev server: `cd frontend && npm run dev`
- Health check: `GET http://localhost:5000/api/health`

## Environment / Secrets

Supabase credentials live in `backend/.env` (see `backend/.env.example` for the required keys). **Never hardcode keys in source files and never commit `.env`.** The service role key bypasses Row Level Security and must only ever be used server-side.

## Auth & Account Approval

- Custom JWT auth (`jsonwebtoken` + `bcryptjs` hashing) against the `users` table — Supabase Auth is NOT used. Requires `JWT_SECRET` (and optional `JWT_EXPIRES_IN`) in `backend/.env`.
- Resident self-registration (`POST /api/auth/register`) creates a **pending** account: `is_active = false`, `profiles.resident_id = null`. Pending accounts cannot log in.
- Secretary review (role `secretary`, routes under `/api/secretary/`): list pending accounts, link each to an existing `resident_records` row or create-and-link a new one, then activate. Activation requires a linked resident record.
- Active residents view their own record via `GET /api/residents/me` through the `profiles.resident_id` link.
- Staff-type accounts (`secretary`, `punong_barangay`, `treasurer`, `staff`) are created only by the Secretary via `POST /api/secretary/accounts` — active immediately, with a generated temporary password (returned once in the response) and `must_change_password = true`.
- Forced password change: `authenticate` default-denies every request from a `must_change_password` user with a 403 + `code: 'PASSWORD_CHANGE_REQUIRED'`; only routes wrapped with `allowPendingPasswordChange` (i.e. `POST /api/auth/change-password`) are reachable. The frontend mirrors this by routing such users to `/change-password`.
- `authenticate` middleware re-reads the user per request, so deactivating an account (or clearing the password flag) takes effect immediately.

## User Roles (5)

Role strings in code and in the `users.role` column always use the lowercase canonical values below, defined in `docs/brgyserve-use-cases.md`. Always say "Punong Barangay", never "Barangay Captain".

1. **Punong Barangay** (`punong_barangay`) — highest approving authority; approves/signs documents, views reports
2. **Barangay Secretary (System Administrator)** (`secretary`) — manages the system, user accounts, resident records, and document processing
3. **Barangay Treasurer** (`treasurer`) — handles payments, transactions, and financial records
4. **Barangay Staff** (`staff`) — assists with day-to-day processing of requests and records
5. **Barangay Resident** (`resident`) — requests documents, books facilities, tracks request status

## Main Modules

- **Document Requests** — residents request barangay documents (clearance, certificates, permits, etc.) and track processing status
- **Facility Rentals** — reservation of barangay facilities
- **Payments / Transactions** — fees for documents and rentals, transaction records
- **Resident Records** — master list of barangay residents (the dataset for the name-matching research component)
- **Dispute / Blotter Records** — incident and complaint records
- **Events & Activities** — barangay events and announcements
- **Reporting** — operational and financial reports for officials

## Research Contribution: Two-Stage Fuzzy Name Matching

The capstone's research component detects **duplicate / near-duplicate resident records** (misspellings, name variations, encoding inconsistencies) using a two-stage pipeline:

1. **Stage 1 — Candidate blocking (database layer):** PostgreSQL `pg_trgm` extension performs trigram similarity blocking to cheaply narrow the full resident table down to candidate pairs. This avoids the O(n²) cost of comparing every record against every other record.
2. **Stage 2 — Fine scoring (application layer):** Jaro-Winkler similarity is computed on each candidate pair in the Node.js backend to produce a final match score. Jaro-Winkler weights agreement in name prefixes, which suits person-name matching.

**Evaluation:** the component is evaluated with **precision, recall, and F1-score** against a labeled set of known duplicate/non-duplicate pairs.

Implementation status:
- Engine implemented in `backend/src/services/nameMatching.js` (`findMatches(first, last, options)`); tunable defaults live in its exported `DEFAULTS` (trigramThreshold 0.3, scoreThreshold 0.85, maxCandidates 50). Do not hardcode thresholds elsewhere — the evaluation sweeps them.
- Stage 1 runs as the `match_resident_candidates` SQL function (migration 003) called via RPC; it uses `set_limit()` + the `%` operator so the GIN indexes are used with a per-call threshold. Jaro-Winkler comes from the `jaro-winkler` npm package and scores the normalized `first last` string (middle names are stored separately and excluded from scoring).
- Test harness: `npm run match:test` (backend); seed test data with planted duplicate pairs in `backend/seeds/test_resident_records.sql` (the six planted pairs are the basis for the future labeled evaluation set).
- Evaluation harness: `npm run match:eval` (backend, `scripts/evaluate-matching.js`) — labeled ground truth manifest mirrors the seed file (6 positive pairs, 624 negative pairs from the 36 seeded records; small initial set to be expanded), runs the real engine, and prints TP/FP/FN/TN + precision/recall/F1 across a Stage 2 threshold sweep. On the current labeled set: perfect separation up to threshold 0.85 (P=R=F1=1.0), recall drops above it. Keep the manifest in sync with the seed file.

## Conventions

- Backend uses CommonJS (`require`), frontend uses ES modules (Vite default)
- API routes are prefixed with `/api/`
- Commit messages must never include AI attribution lines ("Co-authored-by: Claude", "Generated with Claude Code", or similar)
- Database schema lives in `docs/brgyserve-database-schema.md` (source of truth) and is applied via numbered SQL files in `backend/migrations/`, run manually in the Supabase SQL Editor. Keep the doc and migrations in sync.
- Implemented so far: schema (migrations 001–004), resident registration with Secretary-approved linking/activation, the frontend auth slice (login/registration pages, auth context with localStorage persistence, role-based routing), the Secretary review screen on `/secretary` (pending list with ranked fuzzy-match suggestions via `GET /api/secretary/pending-residents/:userId/match-suggestions`, link/create-and-link, activate), and document-type management on `/secretary/document-types` (`/api/document-types`: active list for any authenticated user; `/all` + create/update/deactivate/reactivate Secretary-only — types are deactivated, never deleted, to preserve future request history; migration 004 added `is_active`), the resident document-request screens and the full Document Requests pipeline (see Document Requests section, incl. the Treasurer's Payments landing page), and rental-item management on `/secretary/rental-items` plus self-service booking and Secretary/Staff/Punong-Barangay rental views (Facility Rentals stages 1–3 — see that section; migration 009). All five roles now have real landing pages (Staff and the Punong Barangay: the read-only rental-bookings list). Check with the user before introducing new architectural patterns.

## Document Requests

- Agreed workflow: resident submits → Secretary approves/rejects → payment (record/verify) → release. The Punong Barangay only views/signs.
- Status lifecycle — canonical lowercase values defined in `backend/src/constants/requestStatus.js` (single source of truth; later stages must not invent new strings): `pending` (resident submitted) → `approved` / `rejected` (Secretary review) → `ready_for_release` (payment verified + signed) → `claimed` (released, `claimed_at` set). `cancelled` = withdrawn by the resident.
- Implemented: Stage 1 document-type management; Stage 2 resident submit (`POST /api/document-requests`, requires a linked resident record) and tracking (`GET /api/document-requests/mine[/:id]` — filtered by `requested_by_user_id`, so users only ever see their own). Resident screens: `/resident` (My Requests) and `/resident/request`. Migration 005 added `requested_at`.
- Stage 3 Secretary processing: `GET /api/document-requests[?status=…]` (list across residents), `GET /:id` (detail incl. full resident record for verification), `POST /:id/approve|reject` — Secretary-only; only `pending` may be decided, reject requires a reason (migration 006 added `rejection_reason` + `processed_at`). Screen: `/secretary/requests`. Rejection reason is shown to the resident in My Requests.
- Resident cancel: `POST /api/document-requests/mine/:id/cancel` — own requests only (404 otherwise), only from `pending` (409 otherwise) → status `cancelled`. Cancel button on pending rows in My Requests. No edit — residents cancel and resubmit.

### Stage 4 (Payment + Release) — planned design

- A `charges` row is created when the Secretary **approves** a document request (`charge_type = 'DOCUMENT'`, `amount` = the document type's fee only for now; the charges table's structure already supports adding fines later).
- Residents pay at the barangay hall (cash) or via GCash by providing a reference number. Payments are **recorded/verified manually** in `payments` (`payment_method`, `reference_no`) — no payment gateway integration.
- Both the **Treasurer and the Secretary** can record/verify payments and mark a charge paid (`charges.status = 'PAID'`).
- The **Secretary** moves the request `approved → ready_for_release` (payment verified) and `ready_for_release → claimed` (sets `claimed_at`), per the shared status vocabulary.
- The SMS notification stub (`logSmsNotification`) fires on `ready_for_release`, same pattern as approve/reject.
- Build order: **4a** charge creation on approval → **4b** payment record/verify + Treasurer dashboard → **4c** release flow (ready_for_release + claimed).
- **4a implemented:** approval inserts the charge (`constants/charges.js` — charge statuses are UPPERCASE per Table 15, unlike lowercase request statuses); zero-fee documents get an amount-0 charge auto-marked `PAID` (nothing to collect; must not wait on the Treasurer). No transaction support in supabase-js, so a failed charge insert reverts the approval; migration 007 adds UNIQUE on `charges.document_request_id` (one charge per request, NULLs exempt) and backfills charges for requests approved before 4a. Charges are embedded in `/mine` and Secretary list/detail responses — no separate charge endpoints.
- **4b implemented:** payment declaration vs verification are modeled separately. The resident declares via `POST /api/document-requests/mine/:id/pay` (`method: onsite|gcash`, GCash requires `reference_no`) — stored as `declared_*` on the charge (migration 008), charge stays UNPAID, re-declarable while unpaid. Verification (`/api/charges`: `GET ?status=` queue + `POST /:id/verify`, roles `treasurer` + `secretary`) creates the `payments` row (verifier in `received_by_user_id`; method/reference default from the declaration, overridable) and flips the charge to PAID with a status-guarded claim → insert → revert-on-failure sequence. The payments table only ever holds verified payments. UI: Pay onsite / Pay via GCash on approved unpaid rows in My Requests; `PaymentsPage` (verification queue) is the Treasurer's landing page and the Secretary's Payments tab. SMS stub fires on verification.
- **4c implemented (module complete):** release flow. `POST /api/document-requests/:id/ready-for-release` (Secretary-only; only from `approved` and only when the charge is `PAID` — zero-fee auto-PAID charges qualify immediately) and `POST /:id/claim` (Secretary-only; only from `ready_for_release`, sets `claimed_at`). Both use status-guarded updates like approve/reject; invalid transitions get 409s with the current status. SMS stub fires on ready_for_release ("ready to claim"), not on claim (the resident is present). No migration — `claimed_at` has existed since migration 001. UI: Secretary request detail shows "Mark ready for release" on approved+PAID (an awaiting-payment note otherwise) and a confirm-guarded "Mark as claimed" on ready_for_release; resident My Requests shows a pickup note on ready_for_release and the claim date on claimed. Every request status is now reachable end to end; charge status `VOID` is the only vocabulary value with no path into it (no voiding flow yet).
- SMS notifications are a deliberate stub: `backend/src/services/smsNotification.js` `logSmsNotification()` console-logs where a real provider (Semaphore/Twilio) would send; callers are wired at approve/reject, payment verification, and ready-for-release.

## Facility Rentals

### Planned design

- **Workflow (self-service, instant confirmation):** rentals are SELF-SERVICE — the resident submits a booking and the system runs the conflict check at submission; if the slot/units are free, the booking is CONFIRMED instantly, otherwise it is refused with a clear reason. There is NO Secretary approve/reject step for rentals (this supersedes the earlier "Secretary approves rentals" plan). The Secretary can view/edit/cancel bookings (later stage); Barangay Staff and the Punong Barangay are view-only.
- **Fees** go through the existing charges/payments system (`charges.rental_request_id` already exists; Treasurer and Secretary can both verify, Treasurer primary).
- **Availability:** a simple conflict check — prevent overlapping bookings for the same item/time slot, and for countable items verify enough units are free in that slot. No visual calendar (future enhancement).
- **Scheduling model:** rentals use a date plus start/end time. Countable items (chairs, tables) have a quantity; whole facilities (court, hall) are single-unit (`quantity_total = 1`).
- **Build order:** (1) rental items setup → (2) resident submission + tracking with the conflict check (instant confirmation) → (3) Secretary schedule management (view/edit/cancel) → (4) payment → (5) return tracking.
- **Stage 1 implemented** (rental-items management, `/api/rental-items` + `/secretary/rental-items`, mirrors document types): active list for any authenticated user; `/all` + create/update/deactivate/reactivate Secretary-only. Soft delete only — future `rental_requests` rows will FK to items, so history must survive. Migration 009 added `fee numeric(10,2)` (per **unit** per booking — facilities are 1 unit, so it reads as per-booking; stage 4 computes `fee × quantity_requested`). Item `type` is canonical lowercase `facility | equipment | furniture`; `facility` enforces `quantity_total = 1` in validation. `quantity_available` currently mirrors `quantity_total` on create/update (a scalar can't express per-time-slot availability; stage 2 derives free units per slot from bookings against `quantity_available`, which later allows damaged/retired stock to lower it below total). Starter items seed: `backend/seeds/sample_rental_items.sql`.
- **Stage 2 implemented** (resident booking + tracking, no migration — `rental_requests` exists since 001): rental statuses in `constants/rentals.js` — `confirmed | cancelled | completed` only (no pending/approved: bookings confirm instantly; `cancelled` frees the slot; `completed` = rental took place, set by a later stage). `POST /api/rental-requests` (requires a linked resident record, same rule as document submit; `processed_by_user_id` stays null — nobody approves) and `GET /mine` (own bookings only, `request_id` desc — the table has no created-at column). API takes `date + start_time + end_time`, composed server-side with an explicit `+08:00` offset (same-day bookings by construction); validates end > start, start in the future, purpose ≤1000, quantity ≥1, facility ⇒ quantity 1, quantity ≤ `quantity_available`. **Conflict check:** overlap = `existing.start < new.end AND existing.end > new.start` (strict — slots touching at an endpoint don't conflict) over non-cancelled bookings of the item; refuse when `used + requested > quantity_available` (facilities are the same math with capacity 1). Refusals name the conflicting slot (facility) or the free unit count (countable). **Concurrency (no transactions in supabase-js):** optimistic insert, then re-check counting only overlapping rows with a LOWER `request_id`; earliest insert always survives, a loser deletes its own row and gets the 409 — never double-books. SMS stub fires on confirmation. Screens: `/resident/book-rental` (item picker with fee/units, date+time+quantity, estimated fee = fee × qty, conflict errors shown inline) and `/resident/rentals` (My rentals list); both in the resident nav.
- **Stage 3 implemented** (Secretary schedule management, no migration): `GET /api/rental-requests[?status=…]` (all bookings, requester name via `users→profiles` embed, ordered `start_datetime` desc) and `GET /:id` are open to `secretary`, `staff`, and `punong_barangay` (view roles); `PUT /:id` (edit date/times/quantity/purpose — the item is fixed) and `POST /:id/cancel` are Secretary-only, enforced server-side. Edits re-run the SAME stage 2 conflict check (shared `findConflict()` helper — one implementation) with `excludeId` so a booking never collides with its own current slot; a post-update re-check reverts to the previous schedule on a race. Only `confirmed` bookings can be edited/cancelled (409 otherwise); cancelling sets `processed_by_user_id` and frees the slot automatically because the conflict check filters out cancelled rows. SMS stub fires on Secretary cancel (the resident is told their booking was cancelled). UI: shared `RentalBookingsPage` (filter, list, edit panel, confirm-guarded cancel) — Secretary's Rentals tab (`/secretary/rentals`, `canManage`), and the same page read-only as the Staff and Punong Barangay landing pages (their first real screens).
- **Stage 5 (planned): Return tracking.** Staff — view-only everywhere else in rentals — get exactly one write action: marking a booking as returned, with outcomes `Returned` / `Returned late` / `Returned with issue` (+ note). Applies ONLY to physical/returnable items (furniture, equipment: chairs, tables, tents, costumes, panel boards); facilities (Basketball Court, Multipurpose Hall) auto-complete after their date with no return step. Includes an overdue view: physical-item bookings past their `end_datetime` not yet marked returned. Build AFTER Stage 3 (Secretary management view) and Stage 4 (rental payment). Note: this expands rental scope beyond booking+payment — the team is to reflect it in Chapters 1–3 of the manuscript.

## Pre-deployment TODO

- Enable Row Level Security (RLS) and write per-role access policies for all tables (`secretary`, `punong_barangay`, `treasurer`, `staff`, `resident`) before deployment — tables are currently UNRESTRICTED.
- Delete or rotate the test `secretary1` seed account before real use; its password was shared in plaintext during development.
