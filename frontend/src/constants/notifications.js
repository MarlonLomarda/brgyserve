// Display metadata for the notifications log. Reuses the existing badge
// variants in index.css rather than introducing new colours.

export const NOTIFICATION_STATUS_META = {
  PENDING: { label: 'Pending', className: 'status-pending' },
  // Deliberately its own badge, and worded as "Simulated" everywhere: a row
  // that was never sent must never look like one that was.
  SIMULATED: { label: 'Simulated', className: 'status-ready' },
  SENT: { label: 'Sent', className: 'status-claimed' },
  FAILED: { label: 'Failed', className: 'status-rejected' },
  SKIPPED: { label: 'No contact number', className: 'gray' },
};

export function notificationStatusMeta(status) {
  return NOTIFICATION_STATUS_META[status] || { label: status || '—', className: 'gray' };
}

export const NOTIFICATION_STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'SIMULATED', label: 'Simulated' },
  { value: 'SKIPPED', label: 'No contact number' },
  { value: 'SENT', label: 'Sent' },
  { value: 'FAILED', label: 'Failed' },
];

// ACCOUNT points at users.user_id — currently only registration rejections.
// It must stay in step with RELATED_TYPE in backend/src/constants/
// notifications.js: a kind missing from the filter list below is a kind the
// Secretary cannot filter the log by.
export const RELATED_TYPE_LABELS = {
  DOCUMENT_REQUEST: 'Document request',
  RENTAL_REQUEST: 'Facility rental',
  CHARGE: 'Payment',
  EVENT: 'Event',
  ACCOUNT: 'Account',
};

export const RELATED_TYPE_FILTERS = [
  { value: 'all', label: 'All kinds' },
  { value: 'DOCUMENT_REQUEST', label: 'Document requests' },
  { value: 'RENTAL_REQUEST', label: 'Facility rentals' },
  { value: 'CHARGE', label: 'Payments' },
  { value: 'EVENT', label: 'Events' },
  { value: 'ACCOUNT', label: 'Accounts' },
];

export function relatedLabel(row) {
  const kind = RELATED_TYPE_LABELS[row.related_type];
  if (!kind) return '—';
  return row.related_to ? `${kind} #${row.related_to}` : kind;
}

// The delivery banner on /secretary/notifications.
//
// SMS AND EMAIL ARE INDEPENDENT, and the banner has to say so. It used to read
// "Sending is simulated... no provider is connected", which was true until
// e4fe369 and then sat directly above a row marked Sent by Resend — the screen
// contradicting its own table. One sentence cannot cover two settings, so
// there is a case per combination.
//
// SMS is expected to stay SIMULATED in this deployment (Semaphore's minimum
// top-up is PHP 560 for a demo of about twenty messages), so the live cases
// are the first two. The other two are written anyway rather than left to
// fall through to wording that would misstate what happened.
//
// RETURNS null WHEN EITHER MODE IS MISSING, and that is deliberate. A frontend
// deployed ahead of the backend receives no email_mode, and defaulting it
// would make the banner assert email is simulated when it may not be. Absence
// is the only honest representation of "we were not told" — the same rule as
// `account: null` and `linked_accounts: []` in the Standing Rules. The page
// renders nothing rather than a claim it cannot support.
export function deliveryBanner(smsMode, emailMode) {
  if (!smsMode || !emailMode) return null;

  const smsLive = smsMode === 'SEMAPHORE';
  const emailLive = emailMode === 'RESEND';

  if (!smsLive && !emailLive) {
    return {
      heading: 'Nothing is sent.',
      body: 'SMS and email are both composed, addressed and recorded here, and stop there. Rows stay marked Simulated rather than Sent for that reason.',
    };
  }
  if (!smsLive && emailLive) {
    return {
      heading: 'SMS is simulated. Email is really sent.',
      body: 'SMS is composed and recorded here but never transmitted, and stays marked Simulated. Password reset emails go out through Resend and are marked Sent.',
    };
  }
  if (smsLive && !emailLive) {
    return {
      heading: 'SMS is really sent. Email is simulated.',
      body: 'SMS leaves the system through its provider and is marked Sent. Email is composed and recorded here but never transmitted, and stays marked Simulated.',
    };
  }
  return {
    heading: 'Messages are really sent.',
    body: 'Both SMS and email leave the system through their providers. A row marked Sent reached a real number or inbox.',
  };
}
