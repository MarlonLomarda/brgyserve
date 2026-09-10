// Terms of Use — the body of the /login modal.
//
// SOURCE OF TRUTH IS docs/legal-copy.md, section "TERMS OF USE". This file is
// that markdown rendered as JSX by hand. If the wording changes, change the
// markdown first and re-render from it; do not edit the copy here directly.
//
// Heading levels: document title h2, numbered sections h3. This document has
// no h4 sub-points — only the Privacy Policy and the Help Center do.
export default function TermsOfUse() {
  return (
    <>
      <h2>Terms of Use</h2>
      <p className="legal-effective">Effective: 10 September 2026</p>

      <h3>1. What BrgyServe is</h3>
      <p>
        BrgyServe is an online service and records portal for Barangay Ubujan,
        Tagbilaran City, Bohol, developed as a capstone research project by BSIT
        students of Holy Name University in coordination with the Barangay.
      </p>
      <p>
        It is publicly deployed for use and evaluation.{' '}
        <strong>
          It is not yet an official service of the Barangay Government.
        </strong>{' '}
        Requests, bookings, and payments made here are real and are acted on by
        Barangay officials, but the portal does not replace the Barangay Office,
        and the Office remains the final authority on any transaction.
      </p>

      <h3>2. Accepting these terms</h3>
      <p>
        By creating an account or using this portal you agree to these terms. If
        you do not agree, please transact at the Barangay Office instead.
      </p>

      <h3>3. Who may hold an account</h3>
      <p>
        You may register if you are a{' '}
        <strong>resident of Barangay Ubujan</strong> and{' '}
        <strong>at least 18 years old</strong>.
      </p>
      <p>
        Registering does not immediately give you access. The Barangay Secretary
        reviews each registration and matches it against the Barangay&apos;s
        records of its inhabitants. Your account becomes usable once it is
        approved and linked to your resident record. A registration may be
        declined — for example if the details you gave do not match the
        Barangay&apos;s records — and you will be shown the reason.
      </p>
      <p>One person may hold one account.</p>

      <h3>4. Accurate information</h3>
      <p>
        The details you submit are used to issue official barangay documents.
        You agree to give true and complete information and to keep it current.
      </p>
      <p>
        Submitting false information, or requesting a document in someone
        else&apos;s name, may result in your account being suspended, the
        document being refused or revoked, and referral to the Barangay for
        whatever action it considers appropriate.
      </p>

      <h3>5. Your account</h3>
      <p>
        Keep your password to yourself. Anything done through your account is
        treated as done by you. Tell the Barangay Office immediately if you
        think someone else has access to it.
      </p>
      <p>
        Choose a password you do not use anywhere else. If you forget it, use{' '}
        <strong>Forgot your password?</strong> on the sign-in page — the link
        that arrives works for 60 minutes and only once.
      </p>

      <h3>6. Acceptable use</h3>
      <p>You agree not to:</p>
      <ul>
        <li>
          Request documents or services in another person&apos;s name without
          authority
        </li>
        <li>Submit false, misleading, or altered information</li>
        <li>
          Attempt to reach records or functions that are not yours, including by
          guessing or modifying web addresses
        </li>
        <li>
          Probe, scan, or attempt to disrupt the portal or the systems behind it
        </li>
        <li>
          Automate requests, or submit them in volumes intended to burden the
          service
        </li>
        <li>Use the portal for anything unlawful</li>
      </ul>

      <h3>7. Document requests</h3>
      <p>
        Submitting a request does not guarantee it will be approved. Barangay
        officials review each one and may approve it, ask for more information,
        or decline it with a reason.
      </p>
      <p>
        Each request is given a tracking number. Approved documents are claimed
        at the Barangay Office; the portal issues the request, not the document
        itself. Requirements, fees, and processing times are set by the
        Barangay.
      </p>

      <h3>8. Facility bookings</h3>
      <p>
        Facilities are booked for a specific date and time and are confirmed
        only when the Barangay approves the booking. Overlapping bookings for
        the same facility and period are not accepted, and a booking may be
        declined or cancelled by the Barangay where the facility is needed for
        official use.
      </p>
      <p>
        You are responsible for the facility or item during the period booked.
        The conditions of use, when it must be returned, and any charge for late
        return or damage are agreed with the Barangay at the time of booking.
      </p>
      <p>
        The portal does not calculate or apply such charges automatically. Where
        one applies, the Barangay Treasurer records it against your account and
        it appears among your charges.
      </p>

      <h3>9. Fees and payment</h3>
      <p>Fees are set by the Barangay, not by this portal.</p>
      <p>
        You may pay in either of two ways:{' '}
        <strong>at the Barangay Office</strong>, or{' '}
        <strong>online by GCash</strong>. Online payment is an additional
        convenience and is never the only option.
      </p>
      <p>
        Online payment is handled by <strong>PayMongo</strong>, on a page hosted
        by them. Your GCash credentials are entered there and are never seen or
        stored by BrgyServe. Once PayMongo confirms a payment, the charge is
        marked paid automatically.
      </p>
      <p>
        If you have paid and your charge still shows as unpaid,{' '}
        <strong>do not pay again</strong> — see the Help Center. Refunds,
        corrections, and disputed payments are handled by the Barangay Office,
        not through the portal.
      </p>

      <h3>10. Notifications</h3>
      <p>
        Notices about your requests, bookings, and payments appear{' '}
        <strong>inside the portal</strong> when you sign in. Email is used only
        to send a password reset link. SMS notification is not currently active
        — messages are recorded against your record but are not delivered to
        your phone.
      </p>
      <p>
        Check the portal for the current status of anything you have submitted.
      </p>

      <h3>11. Availability</h3>
      <p>
        The portal is offered as it is. It runs on free hosting tiers, so the
        first page load after a period of inactivity can take up to a minute
        while the server starts, and service may be interrupted for maintenance
        or by circumstances outside our control.
      </p>
      <p>
        We do not guarantee uninterrupted availability. If the portal is
        unavailable and your matter is urgent, go to the Barangay Office.
      </p>

      <h3>12. Suspension</h3>
      <p>
        An account may be suspended or removed where these terms are broken,
        where a registration turns out not to belong to a resident of Barangay
        Ubujan, or at the Barangay&apos;s direction.
      </p>

      <h3>13. Privacy</h3>
      <p>
        How your personal data is handled is set out in the{' '}
        <strong>Privacy Policy</strong>, which forms part of these terms.
      </p>

      <h3>14. Changes</h3>
      <p>
        These terms may change. The effective date at the top will be updated
        when they do, and continuing to use the portal means you accept the
        change.
      </p>

      <h3>15. Governing law</h3>
      <p>
        These terms are governed by the laws of the{' '}
        <strong>Republic of the Philippines</strong>. Any matter not resolved at
        the Barangay Office is subject to the appropriate venue in Tagbilaran
        City, Bohol.
      </p>

      <h3>16. Contact</h3>
      <p>
        <strong>Barangay Ubujan</strong>, Tagbilaran City, Bohol
        <br />
        Open Monday to Friday, 8:00 AM to 5:00 PM. Closed Saturdays and Sundays.
      </p>
    </>
  );
}
