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
├── backend/           # Express API. Dev server: npm run dev (http://localhost:5000)
│   ├── src/
│   │   ├── server.js          # Express entry point
│   │   └── config/supabase.js # Supabase client (reads keys from .env)
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

## User Roles (5)

1. **Punong Barangay** — barangay captain; approves/signs documents, oversees operations, views reports
2. **Barangay Secretary (System Administrator)** — manages the system, user accounts, resident records, and document processing
3. **Barangay Treasurer** — handles payments, transactions, and financial records
4. **Barangay Staff** — assists with day-to-day processing of requests and records
5. **Barangay Resident** — requests documents, books facilities, tracks request status

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

Implementation notes for future work:
- `pg_trgm` must be enabled in Supabase: `create extension if not exists pg_trgm;`
- Blocking threshold (trigram `similarity()`) and final Jaro-Winkler threshold are tunable parameters; the evaluation should report metrics across thresholds.

## Conventions

- Backend uses CommonJS (`require`), frontend uses ES modules (Vite default)
- API routes are prefixed with `/api/`
- No features or database tables exist yet — only the scaffold, Supabase connection, and this documentation. Check with the user before introducing new architectural patterns.
