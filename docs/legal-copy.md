# BrgyServe — Help Center, Terms of Use, Privacy Policy

Source copy for the three `/login` modals, and the source of truth for their
wording. Every factual claim below was checked against the codebase on
10 September 2026. If the system changes, change this file and re-render the
modals from it — do not edit the JSX copy directly.

Heading levels are the intended render: the modal title is `h2`, numbered
sections are `h3`, sub-points are `h4`.

---

## PRIVACY POLICY

*Effective: 10 September 2026*

### Who we are, and what this system is

BrgyServe is an online service and records portal for **Barangay Ubujan,
Tagbilaran City, Bohol**. It is a capstone research project developed by BSIT
students of Holy Name University in coordination with the Barangay.

It is deployed publicly so that residents and Barangay officials can use and
evaluate it. It is **not yet an official service of the Barangay Government**,
and a transaction made here does not replace one made at the Barangay Office.

The Barangay holds and is responsible for the resident records shown in this
system. The student development team operates the software and its hosting on
the Barangay's behalf for the duration of the project.

This policy explains what personal data BrgyServe holds, why it holds it, who
else receives it, and what you can ask us to do about it. It is written to
comply with the **Data Privacy Act of 2012 (RA 10173)**.

### 1. What we hold

#### Barangay masterlist records

The Barangay maintains a record of its inhabitants. For each person that record
may contain: first name, middle name, last name, suffix, birthdate, birthplace,
address, sex, civil status, religion, educational attainment, contact number,
the date the record was created, and the date the person was registered in the
masterlist.

**A record may exist for you before you create an account here, and it will
continue to exist if you never create one.** These records come from the
Barangay's own records, not from your use of this portal.

Some of these fields are **sensitive personal information** under RA 10173 —
your religion, your civil status, and your age as derived from your birthdate.
We hold them because they appear in the Barangay's records of its inhabitants
and are used in issuing certifications and preparing barangay reports. They are
never used to decide whether a request of yours is approved.

#### Account information

If you register: your username, email address, your password stored only as a
bcrypt hash and never in readable form, your role, the date you registered, and
— if your registration is declined — the reason recorded and which official
recorded it.

#### What you do in the portal

Document requests and their status, facility bookings and returns, charges and
payments, event attendance recorded by Barangay staff, your household
membership, and blotter or dispute records in which you are named as a party.

#### Messages composed for you

The text of each notification, the email address or mobile number it was
addressed to, and whether it was delivered.

#### What we do **not** hold

- **No uploaded files of any kind.** BrgyServe has no upload feature. There are
  no ID photographs, no scanned documents, no profile pictures, no attachments.
- **No card or e-wallet credentials.** These never touch BrgyServe. See §3.
- **No biometrics and no location data.**
- **No login history.** We do not record when you sign in, from where, or from
  what device.

### 2. Why we hold it

- To identify you as a resident of Barangay Ubujan when you request a service
- To issue and track barangay certifications, clearances, and permits
- To process facility bookings and the fees attached to them
- To record payments and keep the Barangay's financial records accurate
- To let Barangay officials answer questions about the status of your request
- To detect duplicate resident records so that one person is not recorded twice
- To let you recover your account if you forget your password

### 3. Who else receives it

BrgyServe relies on the following service providers. We do not sell your data,
and we do not share it for advertising.

| Provider | What it receives | When |
|---|---|---|
| **Supabase** | The database. All records described in §1. | Always |
| **PayMongo** | Your name, email address, and mobile number where we hold them; the amount, the description of what is being paid for, and our internal charge reference. | Only when you choose to pay by GCash |
| **Resend** | Your email address, your first name, and the reset link. | Only when you request a password reset |
| **Render** | Backend hosting. Processes all of the above. | Always |
| **Vercel** | Frontend hosting. Receives request information when you load the site. | Always |
| **Cloudflare** | Sits in front of our backend, so portal traffic passes through it. | Always |

**On GCash payments.** When you pay by GCash you are taken to a payment page
hosted by PayMongo. Your GCash credentials are entered on their page, not ours.
BrgyServe never sees, receives, or stores them. What comes back to us is only a
payment reference, the amount, and the fact that it succeeded. We have also
disabled PayMongo's own receipt email, so paying does not sign you up for
anything.

We cannot state which sub-processors these providers use in turn, or every
country in which they may hold data. Their own privacy policies govern that.

### 4. Where it is stored

Our backend runs in **Singapore**. Password reset emails are dispatched from a
provider region in **Tokyo, Japan**. The database is hosted by Supabase.
Personal data is therefore processed outside the Philippines, as RA 10173
permits, and we remain accountable for it.

### 5. How we protect it

- All traffic between you and BrgyServe is encrypted in transit (HTTPS/TLS)
- Passwords are stored as bcrypt hashes and cannot be read back, including by us
- Row-level security is enabled on every table in the database
- Password reset links are stored only as a SHA-256 hash, expire after 60
  minutes, and stop working after a single use
- Sign-in, registration, and password-reset attempts are rate-limited, and each
  account may only be sent one reset email every 15 minutes
- Officials and staff see only the data their role requires. Staff accounts, for
  example, are served resident lists with contact details removed entirely
- Security headers are applied to every response

**A limit we will state rather than paper over.** Our hosting provider retains
server logs for a limited period, and those logs may contain a contact number
and the text of a notification composed for you. They are not public, but they
are not encrypted either.

### 6. How long we keep it

**We currently keep records indefinitely.** There is no automatic deletion.
Archiving a resident record or an event marks it as archived; it does not
remove it. Requests, bookings, charges, payments, and notification records are
retained so that the Barangay's records remain complete and auditable.

If you want a record corrected or removed, ask at the Barangay Office. See §7.

### 7. Your rights under RA 10173

You have the right to:

- **Be informed** — this document, and to be told if your data is used in a new
  way
- **Access** — ask what we hold about you and get a copy of it
- **Correct** — have inaccurate or incomplete records fixed
- **Object** — refuse processing that is not required by law or by the
  Barangay's mandate
- **Erasure or blocking** — ask that data be removed or withheld where it is
  incomplete, outdated, unlawfully obtained, or no longer necessary
- **Damages** — be compensated for harm caused by inaccurate, unlawfully
  obtained, or unauthorised use of your data
- **Complain** — bring a complaint to the National Privacy Commission at
  privacy.gov.ph

To exercise any of these, visit the **Barangay Ubujan Office** during office
hours and bring a valid ID. Because these records belong to the Barangay, some
requests will be decided by the Barangay rather than by the development team.

### 8. Children

Portal accounts are for residents **18 and older**. Records of residents under
18 may appear in the Barangay masterlist and in household records, because the
Barangay maintains records of all of its inhabitants. Those records are managed
by the Barangay and a minor does not hold an account here. A parent or guardian
may raise any question about a minor's record at the Barangay Office.

### 9. Changes to this policy

If this policy changes we will update the effective date at the top. Continuing
to use the portal after a change means you accept the updated policy.

### 10. Contact

**Barangay Ubujan**, Tagbilaran City, Bohol
Open Monday to Friday, 8:00 AM to 5:00 PM. Closed Saturdays and Sundays.

Questions about this policy, and the requests described in Section 7, are
received in person at the Barangay Office.

---

## TERMS OF USE

*Effective: 10 September 2026*

### 1. What BrgyServe is

BrgyServe is an online service and records portal for Barangay Ubujan,
Tagbilaran City, Bohol, developed as a capstone research project by BSIT
students of Holy Name University in coordination with the Barangay.

It is publicly deployed for use and evaluation. **It is not yet an official
service of the Barangay Government.** Requests, bookings, and payments made
here are real and are acted on by Barangay officials, but the portal does not
replace the Barangay Office, and the Office remains the final authority on any
transaction.

### 2. Accepting these terms

By creating an account or using this portal you agree to these terms. If you do
not agree, please transact at the Barangay Office instead.

### 3. Who may hold an account

You may register if you are a **resident of Barangay Ubujan** and **at least 18
years old**.

Registering does not immediately give you access. The Barangay Secretary
reviews each registration and matches it against the Barangay's records of its
inhabitants. Your account becomes usable once it is approved and linked to your
resident record. A registration may be declined — for example if the details
you gave do not match the Barangay's records — and you will be shown the reason.

One person may hold one account.

### 4. Accurate information

The details you submit are used to issue official barangay documents. You agree
to give true and complete information and to keep it current.

Submitting false information, or requesting a document in someone else's name,
may result in your account being suspended, the document being refused or
revoked, and referral to the Barangay for whatever action it considers
appropriate.

### 5. Your account

Keep your password to yourself. Anything done through your account is treated
as done by you. Tell the Barangay Office immediately if you think someone else
has access to it.

Choose a password you do not use anywhere else. If you forget it, use **Forgot
your password?** on the sign-in page — the link that arrives works for 60
minutes and only once.

### 6. Acceptable use

You agree not to:

- Request documents or services in another person's name without authority
- Submit false, misleading, or altered information
- Attempt to reach records or functions that are not yours, including by
  guessing or modifying web addresses
- Probe, scan, or attempt to disrupt the portal or the systems behind it
- Automate requests, or submit them in volumes intended to burden the service
- Use the portal for anything unlawful

### 7. Document requests

Submitting a request does not guarantee it will be approved. Barangay officials
review each one and may approve it, ask for more information, or decline it
with a reason.

Each request is given a tracking number. Approved documents are claimed at the
Barangay Office; the portal issues the request, not the document itself.
Requirements, fees, and processing times are set by the Barangay.

### 8. Facility bookings

Facilities are booked for a specific date and time and are confirmed only when
the Barangay approves the booking. Overlapping bookings for the same facility
and period are not accepted, and a booking may be declined or cancelled by the
Barangay where the facility is needed for official use.

You are responsible for the facility or item during the period booked. The
conditions of use, when it must be returned, and any charge for late return or
damage are agreed with the Barangay at the time of booking.

The portal does not calculate or apply such charges automatically. Where one
applies, the Barangay Treasurer records it against your account and it appears
among your charges.

### 9. Fees and payment

Fees are set by the Barangay, not by this portal.

You may pay in either of two ways: **at the Barangay Office**, or **online by
GCash**. Online payment is an additional convenience and is never the only
option.

Online payment is handled by **PayMongo**, on a page hosted by them. Your GCash
credentials are entered there and are never seen or stored by BrgyServe. Once
PayMongo confirms a payment, the charge is marked paid automatically.

If you have paid and your charge still shows as unpaid, **do not pay again** —
see the Help Center. Refunds, corrections, and disputed payments are handled by
the Barangay Office, not through the portal.

### 10. Notifications

Notices about your requests, bookings, and payments appear **inside the portal**
when you sign in. Email is used only to send a password reset link. SMS
notification is not currently active — messages are recorded against your
record but are not delivered to your phone.

Check the portal for the current status of anything you have submitted.

### 11. Availability

The portal is offered as it is. It runs on free hosting tiers, so the first page
load after a period of inactivity can take up to a minute while the server
starts, and service may be interrupted for maintenance or by circumstances
outside our control.

We do not guarantee uninterrupted availability. If the portal is unavailable and
your matter is urgent, go to the Barangay Office.

### 12. Suspension

An account may be suspended or removed where these terms are broken, where a
registration turns out not to belong to a resident of Barangay Ubujan, or at the
Barangay's direction.

### 13. Privacy

How your personal data is handled is set out in the **Privacy Policy**, which
forms part of these terms.

### 14. Changes

These terms may change. The effective date at the top will be updated when they
do, and continuing to use the portal means you accept the change.

### 15. Governing law

These terms are governed by the laws of the **Republic of the Philippines**.
Any matter not resolved at the Barangay Office is subject to the appropriate
venue in Tagbilaran City, Bohol.

### 16. Contact

**Barangay Ubujan**, Tagbilaran City, Bohol
Open Monday to Friday, 8:00 AM to 5:00 PM. Closed Saturdays and Sundays.

---

## HELP CENTER

Answers to what residents actually run into. If your question is not here, visit
the Barangay Office.

### Getting started

#### How do I create an account?

Choose **Register as a resident** on the sign-in page and fill in your details
as they appear in the Barangay's records. Use your full legal name, including
your middle name, and the address on record.

#### Why does my account say it is waiting for activation?

Because it is. Every registration is reviewed by the Barangay Secretary, who
matches your details against the Barangay's records of its inhabitants before
activating the account. Until then you can sign in but cannot submit requests.

If it has been several days, visit the Barangay Office and ask.

#### My registration was declined. Why?

You will be shown the reason. The usual cause is that the details submitted did
not match the Barangay's records — a different spelling, a middle name left out,
an old address. Bring a valid ID to the Barangay Office and the Secretary can
correct the record or activate the account directly.

#### I have never used this portal. Is my information already here?

Yes. The Barangay maintains a record of its inhabitants, and that record exists
whether or not you register. Registering links your account to your existing
record rather than creating a new one. The Privacy Policy sets out exactly what
that record contains.

### Signing in

#### I forgot my password.

Choose **Forgot your password?** on the sign-in page and enter the email address
on your account. If it belongs to an active resident account, a reset link is
sent to it.

The link works for **60 minutes** and **only once**. If it has expired, request
a new one. Check your spam folder before assuming it did not arrive.

For your protection the page gives the same response whether or not the address
is registered — so it cannot be used to find out who has an account here.

#### I never received the reset email.

Check spam first. Then check that the address is the one on your account —
password reset only goes to the address the Barangay has on file, and only for
resident accounts. If your account has no email address recorded, or you are not
sure which address it uses, the Barangay Office can reset it for you.

#### Why am I signed out?

Sessions expire after a period. Sign in again. If it happens repeatedly, clear
your browser's saved site data for this site and try once more.

### Document requests

#### How do I request a document?

Sign in, open **Document Requests**, choose the document, fill in the required
details, and submit. You will get a tracking number.

#### What do the statuses mean?

- **Pending** — submitted, waiting for review
- **Processing** — approved and being prepared
- **Ready for release** — prepared, waiting for you at the Barangay Office
- **Claimed** — you have collected it
- **Rejected** — not approved; the reason is shown on the request

#### What is the tracking number for?

It identifies your request. Quote it when you ask about your request at the
Barangay Office — it is faster and more precise than a name.

#### How long does it take?

That depends on the document and on the Barangay's schedule. Check the status in
the portal rather than waiting for a message — the portal is always current.

#### Do I still need to go to the office?

Yes. The portal submits and tracks the request. The document itself is printed,
signed, and claimed at the Barangay Office.

### Payments

#### How do I pay?

Two ways: at the Barangay Office, or online by GCash. Online is optional and
always has the office as an alternative.

#### Is paying by GCash safe?

The payment page is hosted by **PayMongo**, a licensed Philippine payment
processor. You enter your GCash details on their page. BrgyServe never sees or
stores them — what comes back to us is a payment reference and the amount.

#### I paid but it still shows as unpaid. What do I do?

**Do not pay again.** Confirmation is usually immediate, but it can lag if your
connection dropped on the way back from the payment page.

Wait a few minutes and reload the page. If it is still unpaid, take your GCash
reference number to the Barangay Office — the Treasurer can check the payment
against the record and settle it. Paying twice creates a second charge that then
has to be refunded manually.

#### Can I get a refund?

Refunds are handled by the Barangay Office, not through the portal. Bring your
GCash reference number.

### Facility bookings

#### How do I book a facility?

Sign in, open the bookings section, choose the facility, and give the date and
time. The Barangay reviews and confirms it. A booking is not confirmed until it
is approved.

#### My requested time was not available.

A facility cannot be booked for two overlapping periods. Choose another slot, or
ask the Barangay Office what is free.

#### What happens when I return the item or facility?

Barangay staff record the return in the portal.

Whether there is any charge for returning late or for damage depends on what was
agreed with the Barangay when you booked. The portal does not work such charges
out on its own — if one applies, the Treasurer records it and it appears among
your charges.

### Notifications and messages

#### Where do I see updates about my request?

Inside the portal, under notifications, when you are signed in. That is the
authoritative place.

#### Will I get a text message?

Not at present. SMS notification is not active. Messages are composed and
recorded against your record, but they are not delivered to your phone. Email
is used only for password reset links.

### If something is wrong

#### My details are wrong in the system.

Ask at the Barangay Office. Resident records are maintained by the Barangay, and
the Secretary can correct them. The portal does not let you edit your own
resident record, because these records are used to issue official documents.

#### I think there are two records for me.

Report it at the Barangay Office. The system flags likely duplicate records for
the Secretary to review, but a report from you is the surest way to have it
looked at.

#### The site is slow to load the first time.

The portal runs on a hosting tier that puts the server to sleep when it is idle.
The first request after a quiet period can take up to a minute while it wakes.
Afterwards it is normal. Give it a moment before reloading.

#### A page will not load at all.

Reload once. If it still fails, try again a few minutes later — the service may
be restarting. If it is urgent, go to the Barangay Office.

### Privacy and terms

#### What data do you hold about me?

See the **Privacy Policy**, which lists every field, who else receives it, and
how long it is kept. It also sets out your rights under the Data Privacy Act of
2012 and how to exercise them.

#### How do I ask for my record to be corrected or removed?

Visit the Barangay Office. Because these are the Barangay's records, the
Barangay decides such requests.

### Still need help?

Visit the **Barangay Ubujan Office**, Tagbilaran City, Bohol.

Open Monday to Friday, 8:00 AM to 5:00 PM. Closed Saturdays and Sundays.
