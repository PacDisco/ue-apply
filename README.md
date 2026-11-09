# ue-apply — Unearthed Education online application

`apply.unearthededucation.org/<trip>` — each school trip has its own link (set on the dashboard's **Unearthed Application Form → Trips & links**). The link decides the trip, so students never pick a program.

| Step | The student / parent | Behind the scenes |
|---|---|---|
| 1 · About you | Name (as in passport), email, date of birth | Application row in Neon + a resume link. HubSpot contact created or updated (company tag *Unearthed Education*). Starting again with the same email for the same trip **emails** a continue link instead of opening the application. |
| 2 · Application | Every question from the Jotform form (edited on the dashboard), passport + photo uploads | Re-validated on the server. HubSpot: parent contacts (labelled **Parent** to the student), the deal in **Unearthed Education → Application Complete** (amount = the trip's payment-schedule total, name "Student — Destination"), and the student / parents / deal linked to the **Unearthed Program** record (labels **Student** / **Parent**) — which is what both portals use. The application is also saved as a submission in Jotform form **251396787451873** with the same field IDs, so both portals, leader edits, group exports and passport checks keep working unchanged. Staff alert email. |
| 3 · Permissions packet | A parent or guardian signs — on the student's device ("they're with me now"), or from an emailed link (`/sign?t=…`) on their own phone. **No deposit until it's signed** (every student is under 18). | Initials on each part (both parts for everyone by default), drawn signature, stored with the exact wording signed, IP and time. A PDF goes onto the student's and parents' HubSpot contacts and the deal; Jotform's "I have completely read and signed the permissions packet" is ticked; the signer gets a copy by email. A parent who signs from the link goes straight on to the deposit on the same page. |
| 4 · Deposit | Card (+3%) or NZ bank account (no fee, NZD trips) on Stripe Checkout — paid by the student from their link, or by the parent right after signing | Deposit = `payment_amount_1` on the trip's program record (or the dashboard override), currency = `program_currency`. Stripe metadata carries `hubspot_deal_id` and `base_amount`, so the dashboard's **payment sync** logs exactly the deposit on exactly this deal and moves it to **Deposit Paid**. Confirmation email to the student (parents cc'd) with the portal link. |

Trips whose school collects payments (`school_collecting_payments` on the program) finish after step 3. A closed / full / past-closing-date trip refuses new applications; people already in can still finish.

## How it fits together

```
 pd-dashboard  /ue-apply-form/  ──writes──▶  Neon: ue_apply_forms, ue_apply_trips
                                                    │ reads
 applicant ──▶ ue-apply (this site) ────────────────┘
                 │ writes Neon: ue_applications, ue_apply_files (+ Blobs "ue-apply-uploads")
                 ├──▶ Jotform 251396787451873 (same field IDs → portals unchanged)
                 ├──▶ HubSpot (contacts, deal, program links, permissions PDF)
                 └──▶ Stripe — Unearthed's account (Checkout + webhook)

 Unearthed portal + leader portal: read Jotform as before. Uploaded files are
 links to https://apply.unearthededucation.org/api/file/<id>, which the portals
 fetch server-side with APPLY_SERVICE_KEY.
 pd-dashboard payment sync: logs the deposit (and every later portal payment)
 on the deal and moves its stage.
```

`public/form-kit.mjs` (form engine), `public/waiver-kit.mjs` (permissions packet) and `public/emails.mjs` (default email wording) have pinned copies in `pd-dashboard/ue-apply-form/` — copy them across after changing them here.

## Setup

1. **Database** — run `MIGRATION-ue-apply.sql` (in pd-dashboard) in the Neon SQL editor.
2. **Netlify site** from this repo (publish `public`, functions `netlify/functions` — already in `netlify.toml`). Domain: `apply.unearthededucation.org`.
3. **Environment variables**

   | Variable | Value |
   |---|---|
   | `APPLY_DATABASE_URL` | the dashboard site's `NETLIFY_DATABASE_URL` (same Neon DB) |
   | `APPLY_SITE_URL` | `https://apply.unearthededucation.org` |
   | `APPLY_SERVICE_KEY` | a long random secret (`openssl rand -hex 32`). The same value goes on the dashboard (`UE_APPLY_SERVICE_KEY`) and on **both** Unearthed portals (`APPLY_SERVICE_KEY`) |
   | `HUBSPOT_TOKEN` | private-app token — contacts, deals, custom objects (read/write), deal pipelines (read), files |
   | `JOTFORM_API_KEY` | the same key the portals use |
   | `STRIPE_SECRET_KEY` | **Unearthed's** Stripe key (the portal's) |
   | `STRIPE_WEBHOOK_SECRET` | from step 4 |
   | `SMTP_USER` / `SMTP_PASS` | the Unearthed mailbox + Google App Password (as the portal's magic-link email) |
   | `UE_APPLY_ALERT_EMAIL` | who hears about new applications and deposits (comma-separate; `off` to disable) |
   | `UE_PORTAL_URL` | the student portal, linked in the deposit email |
   | optional | `SMTP_FROM_NAME` (default "Unearthed Education"), `UE_DEAL_PIPELINE` (default 836668844), `UE_STUDENT_LABEL` / `UE_PARENT_LABEL` (default Student / Parent), `UE_COMPANY_TAG`, `UE_BANK_DEBIT_CURRENCIES` (default NZD), `JOTFORM_MIRROR=off`, `HUBSPOT_SYNC=off`, `DASHBOARD_URL` |

4. **Stripe webhook** (Unearthed account): Developers → Webhooks → `https://apply.unearthededucation.org/api/stripe-webhook`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`. Signing secret → `STRIPE_WEBHOOK_SECRET`. The portal's own checkouts are ignored here.
5. **Dashboard** — on pd-dashboard set `UE_APPLY_SITE_URL=https://apply.unearthededucation.org` and `UE_APPLY_SERVICE_KEY`. Open **Unearthed Application Form** → *Import from Jotform* → check the questions → *Permissions packet* → *Trips & links* (one link per school trip) → **Publish**.
6. **Portals** — on both Unearthed portal sites set `APPLY_SERVICE_KEY` (same secret) and deploy their updated `get-document` functions, so passport and photo files uploaded here open in the portals.
7. **School launch pages** — link each school's page on the Unearthed website to its `apply.unearthededucation.org/<trip>` link. UTM parameters on the link are recorded.

## Before switching the old Jotform off

While applications still come in on the old Jotform form, its own payment field and the UE Applications dashboard keep working as before. Once every school link points here:
- remove the payment field / hide the old form's link on the website (the form must stay **enabled** — it receives this site's submissions);
- Jotform notification / autoresponder emails fire on these submissions too — turn off any you don't want doubled.

## Tests

`npm test` (pure) · `npm run test:flow` (needs a local Postgres at `TEST_PG_URL`, default `postgres://postgres@127.0.0.1:55432/apply`; HubSpot, Jotform, Stripe, Blobs and email are faked).
