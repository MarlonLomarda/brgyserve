# CLAUDE.md archive

This file holds text moved out of `CLAUDE.md` on 13 Oct 2026, verbatim, under the headings it had there and in its original order. It was moved because `CLAUDE.md` is loaded into every Claude Code session and had grown to about 200,000 characters, past the 150,000-character limit; the blocks below are history (what was measured, verified or fixed), not rules a session must follow. Nothing here was summarised, reworded or corrected, so some of it describes the system as it was when written.

This file is NOT loaded automatically, and a rule written here does not govern. Rules belong in `CLAUDE.md`; build narrative belongs in `docs/brgyserve-implementation-log.md`.

# BrgyServe

## Deployment

### Security response headers — helmet (`24665ba`)

**Before this the API sent no security headers at all** — no CSP, no `X-Content-Type-Options`, no `Referrer-Policy`, no `X-Frame-Options` — and advertised `X-Powered-By: Express` on every response, which fingerprints the stack for free and is the first line of any scanner's report. Verified live on the deployed instance before the change was made.

## A schema change is not finished when the migration is applied

**This used to live inside Notifications under the heading "WHEN EMAIL NOTIFICATION IS IMPLEMENTED", which made an unconditional rule look like a note about a feature that does not exist yet.** It has governed **seven applied migrations** (015–021), none of them about notifications, so it now sits beside the Conventions rule above about keeping `docs/brgyserve-database-schema.md` and `backend/migrations/` in sync — the same subject.

## Frontend Layout

### The 640px mobile treatment — one breakpoint, three changes

**Four of those five predate PR #11**: 480, 560, 640 and 768 all existed at `c2bb4f2`, the last commit on main before the merge. So the "only breakpoint" sentence was already contradicted by the file it described. **900px is NOT one of them and never was at any commit checked** — it survives only as prose in four `index.css` comments describing the drawer's pre-`07cc26d` history, which is why `grep -rn '\b900\b' frontend/src` still returns nothing (`900px` has no word boundary before `px`).

#### PR #7 MOVED THE SEARCH INPUT OUT OF `.head-actions`, AND ISSUE 7's RULE NO LONGER MATCHES IT

`.searchbar`'s fixed 500px is also what fixed the long-standing **input collapse just above the breakpoint** — at 641px the input measured **26px** on Blotter and Events before PR #7, with the Events header overflowing by 6px; it is 140px and 108px now, with no overflow.

### The dashboard header is STICKY (`a62f8d7`)

**Measured against `main` at 1280 and 1920 before shipping — two stylesheets on disk, not a runtime injection — and every value matched exactly: all six protected desktop rules, the 1132px content box, table widths, and `.table-wrap` overflow.** That result is not luck and generalises: `position: sticky` keeps the element **in flow** and does not change its width, and `.dash-header` is a **sibling** of `.dash-main` rather than an ancestor, so it cannot enter the width cascade the payments column budget depends on. The 45.5px of slack in that budget was untouched. (That budget no longer exists: since 9 Oct 2026 the Payments rows are one line — see the protected desktop rules.)

## Households

- **NO MIGRATION.** The live schema was introspected before any code (via PostgREST's OpenAPI document, which reports real columns) and **matches Chapter 3 exactly** — no extra columns, no missing ones, all three tables empty. Everything stage 1 needs already exists, so nothing was altered.

## GCash Payment Gateway (PayMongo) — implemented

- **Trigger 4 verified in the browser, 18 Aug 2026** (`c95fd4e`): the **409** on a charge with no checkout session; the reached-PayMongo wording on an abandoned session — which is the proof the route really leaves the server, since the local poll cannot produce that sentence; the **10s cooldown** locking the button between presses; and the **`recorded` path settling a real sandbox payment**, leaving **one** `payments` row on the Treasurer's screen. That last one is the assertion that matters: a second row would have meant the funnel's idempotency did not hold from the new entry point.

## Outstanding work on the live system

- ~~`cd frontend && npm run test:auth` does not run~~ — **fixed 27 Sep 2026; it runs and passes 61 of 61.** It had died since the PR #4 image merge with `UNLOADABLE_DEPENDENCY`: its rolldown build had no loader for the **four** images `LoginPage.jsx` (three, in `assets/loginSlider/`) and `LandingPage.jsx` (`brgy-hall.jpeg`) import, so it read their bytes as source. An `image-as-filename` plugin in `scripts/test-auth-session.cjs` now turns each import into its file name. The same change fixed a check that could never fail: `'CONTROL: a valid token still renders the logged-in view'` asserted the absence of "Sign in to BrgyServe", a string the app has never rendered. It now asserts the account menu button (`aria-label="Account menu"`) on the dashboard and not on the login screen; until `0a5a659` moved Log out into that menu, it asserted "Log out".

- ~~At 390px the Collections report's Monthly table scrolls inside its card by 54px~~ — **fixed 12 Oct 2026 by `dee0976`**, with the rule this item proposed: `.report-sheet .data-table th.num { white-space: normal }`, beside the other `.report-sheet` rules in `index.css`. The "Collected (by billed month)" header now wraps, to two lines at 390 and three at 320, and the table scrolls 0 at both (it was 54 and 124). The same rule wraps "Units booked", so Facility utilization's By item table scrolls 59px at 390 instead of 100. "By charge type" still scrolls 78px there: its headers are single words. Measured in headless Chrome on live data for all four reports: the other tables keep their size at 320 and 390, and all twelve are unchanged at 768, 1280 and 1920 (see the log entry under Reporting).
