// Privacy Policy — the body of the /login modal.
//
// THE FILENAME IS `LegalPrivacy.jsx` ON PURPOSE. DO NOT RENAME IT BACK.
// Brave Shields — and ad-blocker filter lists generally — match request paths
// containing "privacypolicy" and block them as trackers. Named
// `PrivacyPolicy.jsx`, the dev server's request for this module is refused
// with net::ERR_BLOCKED_BY_CLIENT, the import fails, and LoginPage renders
// nothing: a white page whose only clue is that one console line. It costs
// whoever hits it a long time, because nothing about the code looks wrong.
// `PrivacyPolicyModal.jsx` does NOT fix it — the matched substring is still
// there. This name breaks the string; the exported component is still
// PrivacyPolicy and the modal is unaffected.
//
// Dev-server only: `vite build` emits a hashed bundle filename, so no
// deployed asset ever carries this path. That is exactly why it is easy to
// miss — it never reproduces on the deployed site.
//
// SOURCE OF TRUTH IS docs/legal-copy.md, section "PRIVACY POLICY". This file is
// that markdown rendered as JSX by hand. If the wording changes, change the
// markdown first and re-render from it; do not edit the copy here directly.
//
// Heading levels are load-bearing: the document title is h2, numbered sections
// are h3, sub-points are h4. `.legal-modal` styles all three so they are
// visibly distinct — see index.css.
//
// The provider table in section 3 reuses `.data-table.stack-narrow` and
// `data-label`, the same mechanism the fifteen dashboard tables use, so below
// 640px each row becomes a labelled card instead of overflowing the modal.
// No table CSS was added for it.
export default function PrivacyPolicy() {
  return (
    <>
      <h2>Privacy Policy</h2>
      <p className="legal-effective">Effective: 10 September 2026</p>

      <h3>Who we are, and what this system is</h3>
      <p>
        BrgyServe is an online service and records portal for{' '}
        <strong>Barangay Ubujan, Tagbilaran City, Bohol</strong>. It is a
        capstone research project developed by BSIT students of Holy Name
        University in coordination with the Barangay.
      </p>
      <p>
        It is deployed publicly so that residents and Barangay officials can use
        and evaluate it. It is{' '}
        <strong>not yet an official service of the Barangay Government</strong>,
        and a transaction made here does not replace one made at the Barangay
        Office.
      </p>
      <p>
        The Barangay holds and is responsible for the resident records shown in
        this system. The student development team operates the software and its
        hosting on the Barangay&apos;s behalf for the duration of the project.
      </p>
      <p>
        This policy explains what personal data BrgyServe holds, why it holds
        it, who else receives it, and what you can ask us to do about it. It is
        written to comply with the{' '}
        <strong>Data Privacy Act of 2012 (RA 10173)</strong>.
      </p>

      <h3>1. What we hold</h3>

      <h4>Barangay masterlist records</h4>
      <p>
        The Barangay maintains a record of its inhabitants. For each person that
        record may contain: first name, middle name, last name, suffix,
        birthdate, birthplace, address, sex, civil status, religion, educational
        attainment, contact number, the date the record was created, and the
        date the person was registered in the masterlist.
      </p>
      <p>
        <strong>
          A record may exist for you before you create an account here, and it
          will continue to exist if you never create one.
        </strong>{' '}
        These records come from the Barangay&apos;s own records, not from your
        use of this portal.
      </p>
      <p>
        Some of these fields are <strong>sensitive personal information</strong>{' '}
        under RA 10173 — your religion, your civil status, and your age as
        derived from your birthdate. We hold them because they appear in the
        Barangay&apos;s records of its inhabitants and are used in issuing
        certifications and preparing barangay reports. They are never used to
        decide whether a request of yours is approved.
      </p>

      <h4>Account information</h4>
      <p>
        If you register: your username, email address, your password stored only
        as a bcrypt hash and never in readable form, your role, the date you
        registered, and — if your registration is declined — the reason recorded
        and which official recorded it.
      </p>

      <h4>What you do in the portal</h4>
      <p>
        Document requests and their status, facility bookings and returns,
        charges and payments, event attendance recorded by Barangay staff, your
        household membership, and blotter or dispute records in which you are
        named as a party.
      </p>

      <h4>Messages composed for you</h4>
      <p>
        The text of each notification, the email address or mobile number it was
        addressed to, and whether it was delivered.
      </p>

      <h4>
        What we do <strong>not</strong> hold
      </h4>
      <ul>
        <li>
          <strong>No uploaded files of any kind.</strong> BrgyServe has no
          upload feature. There are no ID photographs, no scanned documents, no
          profile pictures, no attachments.
        </li>
        <li>
          <strong>No card or e-wallet credentials.</strong> These never touch
          BrgyServe. See §3.
        </li>
        <li>
          <strong>No biometrics and no location data.</strong>
        </li>
        <li>
          <strong>No login history.</strong> We do not record when you sign in,
          from where, or from what device.
        </li>
      </ul>

      <h3>2. Why we hold it</h3>
      <ul>
        <li>
          To identify you as a resident of Barangay Ubujan when you request a
          service
        </li>
        <li>
          To issue and track barangay certifications, clearances, and permits
        </li>
        <li>To process facility bookings and the fees attached to them</li>
        <li>
          To record payments and keep the Barangay&apos;s financial records
          accurate
        </li>
        <li>
          To let Barangay officials answer questions about the status of your
          request
        </li>
        <li>
          To detect duplicate resident records so that one person is not
          recorded twice
        </li>
        <li>To let you recover your account if you forget your password</li>
      </ul>

      <h3>3. Who else receives it</h3>
      <p>
        BrgyServe relies on the following service providers. We do not sell your
        data, and we do not share it for advertising.
      </p>

      {/* stack-narrow: below 640px each provider becomes a labelled card
          instead of a six-column row the modal cannot fit. The data-label
          attributes are what the hidden column headers are replaced with —
          the same mechanism the dashboard list tables use. The Provider cell
          is the card's heading, so it carries no label, matching the rule the
          other tables follow. */}
      <div className="table-wrap">
        <table className="data-table stack-narrow">
          <thead>
            <tr>
              <th>Provider</th>
              <th>What it receives</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Supabase</strong>
              </td>
              <td data-label="What it receives">
                The database. All records described in §1.
              </td>
              <td data-label="When">Always</td>
            </tr>
            <tr>
              <td>
                <strong>PayMongo</strong>
              </td>
              <td data-label="What it receives">
                Your name, email address, and mobile number where we hold them;
                the amount, the description of what is being paid for, and our
                internal charge reference.
              </td>
              <td data-label="When">Only when you choose to pay by GCash</td>
            </tr>
            <tr>
              <td>
                <strong>Resend</strong>
              </td>
              <td data-label="What it receives">
                Your email address, your first name, and the reset link.
              </td>
              <td data-label="When">Only when you request a password reset</td>
            </tr>
            <tr>
              <td>
                <strong>Render</strong>
              </td>
              <td data-label="What it receives">
                Backend hosting. Processes all of the above.
              </td>
              <td data-label="When">Always</td>
            </tr>
            <tr>
              <td>
                <strong>Vercel</strong>
              </td>
              <td data-label="What it receives">
                Frontend hosting. Receives request information when you load the
                site.
              </td>
              <td data-label="When">Always</td>
            </tr>
            <tr>
              <td>
                <strong>Cloudflare</strong>
              </td>
              <td data-label="What it receives">
                Sits in front of our backend, so portal traffic passes through
                it.
              </td>
              <td data-label="When">Always</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p>
        <strong>On GCash payments.</strong> When you pay by GCash you are taken
        to a payment page hosted by PayMongo. Your GCash credentials are entered
        on their page, not ours. BrgyServe never sees, receives, or stores them.
        What comes back to us is only a payment reference, the amount, and the
        fact that it succeeded. We have also disabled PayMongo&apos;s own
        receipt email, so paying does not sign you up for anything.
      </p>
      <p>
        We cannot state which sub-processors these providers use in turn, or
        every country in which they may hold data. Their own privacy policies
        govern that.
      </p>

      <h3>4. Where it is stored</h3>
      <p>
        Our backend runs in <strong>Singapore</strong>. Password reset emails
        are dispatched from a provider region in{' '}
        <strong>Tokyo, Japan</strong>. The database is hosted by Supabase.
        Personal data is therefore processed outside the Philippines, as RA
        10173 permits, and we remain accountable for it.
      </p>

      <h3>5. How we protect it</h3>
      <ul>
        <li>
          All traffic between you and BrgyServe is encrypted in transit
          (HTTPS/TLS)
        </li>
        <li>
          Passwords are stored as bcrypt hashes and cannot be read back,
          including by us
        </li>
        <li>Row-level security is enabled on every table in the database</li>
        <li>
          Password reset links are stored only as a SHA-256 hash, expire after
          60 minutes, and stop working after a single use
        </li>
        <li>
          Sign-in, registration, and password-reset attempts are rate-limited,
          and each account may only be sent one reset email every 15 minutes
        </li>
        <li>
          Officials and staff see only the data their role requires. Staff
          accounts, for example, are served resident lists with contact details
          removed entirely
        </li>
        <li>Security headers are applied to every response</li>
      </ul>
      <p>
        <strong>A limit we will state rather than paper over.</strong> Our
        hosting provider retains server logs for a limited period, and those
        logs may contain a contact number and the text of a notification
        composed for you. They are not public, but they are not encrypted
        either.
      </p>

      <h3>6. How long we keep it</h3>
      <p>
        <strong>We currently keep records indefinitely.</strong> There is no
        automatic deletion. Archiving a resident record or an event marks it as
        archived; it does not remove it. Requests, bookings, charges, payments,
        and notification records are retained so that the Barangay&apos;s
        records remain complete and auditable.
      </p>
      <p>
        If you want a record corrected or removed, ask at the Barangay Office.
        See §7.
      </p>

      <h3>7. Your rights under RA 10173</h3>
      <p>You have the right to:</p>
      <ul>
        <li>
          <strong>Be informed</strong> — this document, and to be told if your
          data is used in a new way
        </li>
        <li>
          <strong>Access</strong> — ask what we hold about you and get a copy of
          it
        </li>
        <li>
          <strong>Correct</strong> — have inaccurate or incomplete records fixed
        </li>
        <li>
          <strong>Object</strong> — refuse processing that is not required by
          law or by the Barangay&apos;s mandate
        </li>
        <li>
          <strong>Erasure or blocking</strong> — ask that data be removed or
          withheld where it is incomplete, outdated, unlawfully obtained, or no
          longer necessary
        </li>
        <li>
          <strong>Damages</strong> — be compensated for harm caused by
          inaccurate, unlawfully obtained, or unauthorised use of your data
        </li>
        <li>
          <strong>Complain</strong> — bring a complaint to the National Privacy
          Commission at privacy.gov.ph
        </li>
      </ul>
      <p>
        To exercise any of these, visit the{' '}
        <strong>Barangay Ubujan Office</strong> during office hours and bring a
        valid ID. Because these records belong to the Barangay, some requests
        will be decided by the Barangay rather than by the development team.
      </p>

      <h3>8. Children</h3>
      <p>
        Portal accounts are for residents <strong>18 and older</strong>. Records
        of residents under 18 may appear in the Barangay masterlist and in
        household records, because the Barangay maintains records of all of its
        inhabitants. Those records are managed by the Barangay and a minor does
        not hold an account here. A parent or guardian may raise any question
        about a minor&apos;s record at the Barangay Office.
      </p>

      <h3>9. Changes to this policy</h3>
      <p>
        If this policy changes we will update the effective date at the top.
        Continuing to use the portal after a change means you accept the updated
        policy.
      </p>

      <h3>10. Contact</h3>
      <p>
        <strong>Barangay Ubujan</strong>, Tagbilaran City, Bohol
        <br />
        Open Monday to Friday, 8:00 AM to 5:00 PM. Closed Saturdays and Sundays.
      </p>
      <p>
        Questions about this policy, and the requests described in Section 7,
        are received in person at the Barangay Office.
      </p>
    </>
  );
}
