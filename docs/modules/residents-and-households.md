# Resident Records Management — module rules

This file holds the rules and current state of the Resident Records Management module, moved out of `CLAUDE.md` on 13 Oct 2026, verbatim. **It is NOT loaded automatically, and it MUST be read before changing this module.** The Households section has not moved: it is still in `CLAUDE.md`, because a code comment cites it there.

## Resident Records Management

**Module invariants that outlive the build narrative:**

- **ARCHIVE IS SOFT-DELETE ONLY — a resident record is NEVER hard-deleted.** It cannot be: `document_requests.resident_id` is NOT NULL and holds real data, so a delete would break history. Archiving **CASCADES** — it also deactivates the linked account (`users.is_active = false`) so no "archived but still logging in" state can exist — and unarchive is symmetric. **Known limitation, accepted:** unarchive reactivates linked accounts unconditionally, so an account deactivated *for cause* before the archive would come back active; distinguishing that needs extra state, so the simple symmetric behaviour stands.
- **EDIT IS REACHABLE ONLY FROM THE DETAIL PANEL, NEVER FROM A LIST ROW.** The list projection omits several columns, so prefilling an edit form from a row would **blank them on save**. Archive/Unarchive live in the detail panel for the same reason. This is a correctness constraint, not a UI preference.
- **The duplicate check on add is deliberately SOFT.** It informs and requires confirmation; it never hard-blocks, because same-name-different-person is real. The server re-runs the check and is the final authority — matches without `confirm_duplicate: true` return a **409 carrying the ranked matches** and insert nothing. It reuses `findMatches` with no options passed, so `DEFAULTS` apply and **thresholds are never hardcoded here** — `npm run match:eval` sweeps them.

**Build detail moved out of this file.** See `docs/brgyserve-implementation-log.md`:

- **"Planned design"** — the three build stages — search, add with the duplicate check, archive with the cascade.
- **"Read-only access for Staff and the Punong Barangay (`177dabd`, `eba84ae`)"** — the six routes, the Staff projection, and the data-minimization argument.
