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
- Implemented so far: schema (migrations 001–004), resident registration with Secretary-approved linking/activation, the frontend auth slice (login/registration pages, auth context with localStorage persistence, role-based routing), the Secretary review screen on `/secretary` (pending list with ranked fuzzy-match suggestions via `GET /api/secretary/pending-residents/:userId/match-suggestions`, link/create-and-link, activate), and document-type management on `/secretary/document-types` (`/api/document-types`: active list for any authenticated user; `/all` + create/update/deactivate/reactivate Secretary-only — types are deactivated, never deleted, to preserve future request history; migration 004 added `is_active`), and the resident document-request screens (see Document Requests section). Punong Barangay, Treasurer, and Staff still have placeholder landing pages. Check with the user before introducing new architectural patterns.

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
- SMS notifications are a deliberate stub: `backend/src/services/smsNotification.js` `logSmsNotification()` console-logs where a real provider (Semaphore/Twilio) would send; callers are already wired at approve/reject (and future release). Payments and release are later stages.

## Pre-deployment TODO

- Enable Row Level Security (RLS) and write per-role access policies for all tables (`secretary`, `punong_barangay`, `treasurer`, `staff`, `resident`) before deployment — tables are currently UNRESTRICTED.
- Delete or rotate the test `secretary1` seed account before real use; its password was shared in plaintext during development.
