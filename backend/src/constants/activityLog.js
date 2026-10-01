// Canonical vocabulary for activity_logs (Table 18), and the keys that must
// never be written into it.
//
// Actions are UPPERCASE, like charge statuses, registration reason codes and
// notification types. table_name is always the REAL table name, so a log row
// can be joined back by hand: household_records, not "households".

const ACTIONS = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  ARCHIVE: 'ARCHIVE',
  UNARCHIVE: 'UNARCHIVE',
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  UNREJECT: 'UNREJECT',
  LINK: 'LINK',
  ACTIVATE: 'ACTIVATE',
  DEACTIVATE: 'DEACTIVATE',
  RELEASE: 'RELEASE',
  CLAIM: 'CLAIM',
  CANCEL: 'CANCEL',
  RETURN: 'RETURN',
  VERIFY_PAYMENT: 'VERIFY_PAYMENT',
  SETTLE_PAYMENT: 'SETTLE_PAYMENT',
  DECLARE_PAYMENT: 'DECLARE_PAYMENT',
  RECORD_ATTENDANCE: 'RECORD_ATTENDANCE',
  REMOVE_ATTENDANCE: 'REMOVE_ATTENDANCE',
  GENERATE_FINES: 'GENERATE_FINES',
  VOID_FINE: 'VOID_FINE',
  SETTLE: 'SETTLE',
  REOPEN: 'REOPEN',
  PASSWORD_CHANGE: 'PASSWORD_CHANGE',
  PASSWORD_RESET: 'PASSWORD_RESET',
  IMPORT: 'IMPORT',
};

// Keys REMOVED from old_value and new_value before a row is written — removed
// entirely, not masked, so a log row never says even that a credential was
// there. Matched case-insensitively on the key name, at every depth.
//
// Exact names: the list agreed for this module, plus the credential-bearing
// names this codebase actually uses — PayMongo's checkout_url (opens the
// hosted payment page) and signature header, the Authorization header,
// Resend's apikey, and the service role key.
const SENSITIVE_KEYS = [
  'password', 'password_hash', 'temp_password', 'temporary_password',
  'token', 'token_hash', 'reset_token', 'reset_link', 'jwt', 'qr_token',
  'secret', 'api_key', 'message', 'provider_response',
  'checkout_url', 'signature', 'authorization', 'apikey', 'service_role_key',
];

// Any key starting with one of these (paymongo_session_id, paymongo_payment_id).
const SENSITIVE_PREFIXES = ['paymongo_'];

// Any key CONTAINING one of these, so the next credential somebody names
// (access_token, webhook_secret, new_password) is caught without an edit
// here. The cost is that must_change_password, a plain flag, is dropped too —
// harmless, and cheaper than a list that has to be remembered.
const SENSITIVE_SUBSTRINGS = ['password', 'token', 'secret'];

// What a CREATE log records about a new resident record: who they are, never
// the rest of the row. The record itself holds birthdate, address, contact
// number, religion and civil status; copying them into the log would hold
// them twice. Shared by both creation paths, the master list and the
// registration review's create-and-link.
const RESIDENT_LOG_FIELDS = ['first_name', 'middle_name', 'last_name', 'suffix'];

function isSensitiveKey(key) {
  const k = String(key).toLowerCase();
  return SENSITIVE_KEYS.includes(k)
    || SENSITIVE_PREFIXES.some((p) => k.startsWith(p))
    || SENSITIVE_SUBSTRINGS.some((s) => k.includes(s));
}

// Keys STORED in old_value / new_value but never DISPLAYED: the Activity Log
// page says "Contact number changed" and sends no value. The log keeps values
// the record no longer shows — an old phone number or address survives only
// here — so showing them would make the page a lookup for data the barangay
// has since replaced. Matched case-insensitively on the exact key name, at
// every depth. Different from SENSITIVE_KEYS, which are never stored at all.
// guest_name / guest_contact are listed defensively; the columns that hold a
// guest's particulars are outside_borrower_name / outside_borrower_contact.
const PERSONAL_FIELDS = [
  'contact_number', 'birthdate', 'birthplace', 'address', 'sex', 'civil_status', 'religion',
  'educational_attainment', 'purpose', 'guest_name', 'guest_contact',
  'outside_borrower_name', 'outside_borrower_contact',
];

const isPersonalKey = (key) => PERSONAL_FIELDS.includes(String(key).toLowerCase());

// Every table a call site logs to — the Activity Log page's record-type filter.
// activity:test fails if a call site logs a table missing here, or if one
// listed here is no longer logged anywhere.
const LOGGED_TABLES = [
  'users', 'profiles', 'resident_records', 'household_records', 'household_members',
  'document_types', 'document_requests', 'charges', 'rental_items', 'rental_requests',
  'events', 'event_attendees', 'dispute_records',
];

module.exports = {
  ACTIONS, SENSITIVE_KEYS, SENSITIVE_PREFIXES, SENSITIVE_SUBSTRINGS, RESIDENT_LOG_FIELDS, isSensitiveKey,
  PERSONAL_FIELDS, isPersonalKey, LOGGED_TABLES,
};
