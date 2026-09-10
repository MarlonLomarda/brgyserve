// Help Center — the body of the /login modal.
//
// SOURCE OF TRUTH IS docs/legal-copy.md, section "HELP CENTER". This file is
// that markdown rendered as JSX by hand. If the wording changes, change the
// markdown first and re-render from it; do not edit the copy here directly.
//
// Heading levels: document title h2, topic groups h3, individual questions h4.
// There is deliberately NO effective-date line — only the Privacy Policy and
// the Terms of Use carry one.
export default function HelpCenter() {
  return (
    <>
      <h2 id="legal-modal-title">Help Center</h2>

      <p>
        Answers to what residents actually run into. If your question is not
        here, visit the Barangay Office.
      </p>

      <h3>Getting started</h3>

      <h4>How do I create an account?</h4>
      <p>
        Choose <strong>Register as a resident</strong> on the sign-in page and
        fill in your details as they appear in the Barangay&apos;s records. Use
        your full legal name, including your middle name, and the address on
        record.
      </p>

      <h4>Why does my account say it is waiting for activation?</h4>
      <p>
        Because it is. Every registration is reviewed by the Barangay Secretary,
        who matches your details against the Barangay&apos;s records of its
        inhabitants before activating the account. Until then you can sign in
        but cannot submit requests.
      </p>
      <p>If it has been several days, visit the Barangay Office and ask.</p>

      <h4>My registration was declined. Why?</h4>
      <p>
        You will be shown the reason. The usual cause is that the details
        submitted did not match the Barangay&apos;s records — a different
        spelling, a middle name left out, an old address. Bring a valid ID to
        the Barangay Office and the Secretary can correct the record or activate
        the account directly.
      </p>

      <h4>I have never used this portal. Is my information already here?</h4>
      <p>
        Yes. The Barangay maintains a record of its inhabitants, and that record
        exists whether or not you register. Registering links your account to
        your existing record rather than creating a new one. The Privacy Policy
        sets out exactly what that record contains.
      </p>

      <h3>Signing in</h3>

      <h4>I forgot my password.</h4>
      <p>
        Choose <strong>Forgot your password?</strong> on the sign-in page and
        enter the email address on your account. If it belongs to an active
        resident account, a reset link is sent to it.
      </p>
      <p>
        The link works for <strong>60 minutes</strong> and{' '}
        <strong>only once</strong>. If it has expired, request a new one. Check
        your spam folder before assuming it did not arrive.
      </p>
      <p>
        For your protection the page gives the same response whether or not the
        address is registered — so it cannot be used to find out who has an
        account here.
      </p>

      <h4>I never received the reset email.</h4>
      <p>
        Check spam first. Then check that the address is the one on your account
        — password reset only goes to the address the Barangay has on file, and
        only for resident accounts. If your account has no email address
        recorded, or you are not sure which address it uses, the Barangay Office
        can reset it for you.
      </p>

      <h4>Why am I signed out?</h4>
      <p>
        Sessions expire after a period. Sign in again. If it happens repeatedly,
        clear your browser&apos;s saved site data for this site and try once
        more.
      </p>

      <h3>Document requests</h3>

      <h4>How do I request a document?</h4>
      <p>
        Sign in, open <strong>Document Requests</strong>, choose the document,
        fill in the required details, and submit. You will get a tracking
        number.
      </p>

      <h4>What do the statuses mean?</h4>
      <ul>
        <li>
          <strong>Pending</strong> — submitted, waiting for review
        </li>
        <li>
          <strong>Processing</strong> — approved and being prepared
        </li>
        <li>
          <strong>Ready for release</strong> — prepared, waiting for you at the
          Barangay Office
        </li>
        <li>
          <strong>Claimed</strong> — you have collected it
        </li>
        <li>
          <strong>Rejected</strong> — not approved; the reason is shown on the
          request
        </li>
      </ul>

      <h4>What is the tracking number for?</h4>
      <p>
        It identifies your request. Quote it when you ask about your request at
        the Barangay Office — it is faster and more precise than a name.
      </p>

      <h4>How long does it take?</h4>
      <p>
        That depends on the document and on the Barangay&apos;s schedule. Check
        the status in the portal rather than waiting for a message — the portal
        is always current.
      </p>

      <h4>Do I still need to go to the office?</h4>
      <p>
        Yes. The portal submits and tracks the request. The document itself is
        printed, signed, and claimed at the Barangay Office.
      </p>

      <h3>Payments</h3>

      <h4>How do I pay?</h4>
      <p>
        Two ways: at the Barangay Office, or online by GCash. Online is optional
        and always has the office as an alternative.
      </p>

      <h4>Is paying by GCash safe?</h4>
      <p>
        The payment page is hosted by <strong>PayMongo</strong>, a licensed
        Philippine payment processor. You enter your GCash details on their
        page. BrgyServe never sees or stores them — what comes back to us is a
        payment reference and the amount.
      </p>

      <h4>I paid but it still shows as unpaid. What do I do?</h4>
      <p>
        <strong>Do not pay again.</strong> Confirmation is usually immediate,
        but it can lag if your connection dropped on the way back from the
        payment page.
      </p>
      <p>
        Wait a few minutes and reload the page. If it is still unpaid, take your
        GCash reference number to the Barangay Office — the Treasurer can check
        the payment against the record and settle it. Paying twice creates a
        second charge that then has to be refunded manually.
      </p>

      <h4>Can I get a refund?</h4>
      <p>
        Refunds are handled by the Barangay Office, not through the portal.
        Bring your GCash reference number.
      </p>

      <h3>Facility bookings</h3>

      <h4>How do I book a facility?</h4>
      <p>
        Sign in, open the bookings section, choose the facility, and give the
        date and time. The Barangay reviews and confirms it. A booking is not
        confirmed until it is approved.
      </p>

      <h4>My requested time was not available.</h4>
      <p>
        A facility cannot be booked for two overlapping periods. Choose another
        slot, or ask the Barangay Office what is free.
      </p>

      <h4>What happens when I return the item or facility?</h4>
      <p>Barangay staff record the return in the portal.</p>
      <p>
        Whether there is any charge for returning late or for damage depends on
        what was agreed with the Barangay when you booked. The portal does not
        work such charges out on its own — if one applies, the Treasurer records
        it and it appears among your charges.
      </p>

      <h3>Notifications and messages</h3>

      <h4>Where do I see updates about my request?</h4>
      <p>
        Inside the portal, under notifications, when you are signed in. That is
        the authoritative place.
      </p>

      <h4>Will I get a text message?</h4>
      <p>
        Not at present. SMS notification is not active. Messages are composed
        and recorded against your record, but they are not delivered to your
        phone. Email is used only for password reset links.
      </p>

      <h3>If something is wrong</h3>

      <h4>My details are wrong in the system.</h4>
      <p>
        Ask at the Barangay Office. Resident records are maintained by the
        Barangay, and the Secretary can correct them. The portal does not let
        you edit your own resident record, because these records are used to
        issue official documents.
      </p>

      <h4>I think there are two records for me.</h4>
      <p>
        Report it at the Barangay Office. The system flags likely duplicate
        records for the Secretary to review, but a report from you is the surest
        way to have it looked at.
      </p>

      <h4>The site is slow to load the first time.</h4>
      <p>
        The portal runs on a hosting tier that puts the server to sleep when it
        is idle. The first request after a quiet period can take up to a minute
        while it wakes. Afterwards it is normal. Give it a moment before
        reloading.
      </p>

      <h4>A page will not load at all.</h4>
      <p>
        Reload once. If it still fails, try again a few minutes later — the
        service may be restarting. If it is urgent, go to the Barangay Office.
      </p>

      <h3>Privacy and terms</h3>

      <h4>What data do you hold about me?</h4>
      <p>
        See the <strong>Privacy Policy</strong>, which lists every field, who
        else receives it, and how long it is kept. It also sets out your rights
        under the Data Privacy Act of 2012 and how to exercise them.
      </p>

      <h4>How do I ask for my record to be corrected or removed?</h4>
      <p>
        Visit the Barangay Office. Because these are the Barangay&apos;s
        records, the Barangay decides such requests.
      </p>

      <h3>Still need help?</h3>
      <p>
        Visit the <strong>Barangay Ubujan Office</strong>, Tagbilaran City,
        Bohol.
      </p>
      <p>
        Open Monday to Friday, 8:00 AM to 5:00 PM. Closed Saturdays and Sundays.
      </p>
    </>
  );
}
