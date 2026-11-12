// "Your payment didn't go through" — for EVERY payment on Unearthed's Stripe
// account: application deposits (this site) and payments made in the student
// and leader portals. Driven by the Stripe webhook (/api/stripe-webhook):
//
//   checkout.session.async_payment_failed  a bank debit (NZ bank account etc.)
//                                          was accepted at checkout, then failed
//                                          days later — the family thinks it's paid.
//   checkout.session.expired               a checkout that ended without a
//                                          payment AFTER a card / bank attempt
//                                          failed (Stripe's last_payment_error).
//                                          Someone who just closed the page
//                                          without trying gets nothing.
//
// Card declines are NOT emailed the moment they happen: the payer is on the
// checkout page, sees the error and can use another card. If they never get
// it through, the checkout expires (Stripe: 24 hours) and the email goes then.
//
// Who hears: the payer, the student and their parents / guardians (from the
// application, or from the HubSpot deal's contacts for portal payments), and
// the team (UE_APPLY_ALERT_EMAIL). Once per checkout (Netlify Blobs marker).
// Off switch: UE_PAYMENT_FAILED_EMAILS=off.
import * as HS from "./hubspot.mjs";
import * as N from "./notify.mjs";
import { appById, publishedSchema, q, noteSync } from "./db.mjs";
import { store } from "./blobs.mjs";
import { flag, newToken, hashToken, siteUrl } from "./http.mjs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);

/** "NZD 1,750" from Stripe minor units. Pure. */
export function moneyText(minor, currency) {
  const c = String(currency || "").toUpperCase();
  const n = Number(minor || 0) / (ZERO_DECIMAL.has(c) ? 1 : 100);
  return `${c} ${n.toLocaleString("en-NZ", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`.trim();
}

/** A plain reason from Stripe's last_payment_error. Pure. */
export function reasonText(err) {
  if (!err) return "The payment was declined.";
  const code = String(err.decline_code || err.code || "").toLowerCase();
  const map = {
    insufficient_funds: "There weren't enough funds in the account.",
    card_declined: "The card was declined by the bank.",
    generic_decline: "The card was declined by the bank.",
    expired_card: "The card has expired.",
    incorrect_cvc: "The security code (CVC) was incorrect.",
    processing_error: "There was a processing error at the bank.",
    do_not_honor: "The bank declined the payment.",
    lost_card: "The card was declined by the bank.",
    stolen_card: "The card was declined by the bank.",
    debit_not_authorized: "The bank account holder didn't authorise the debit.",
    account_closed: "The bank account is closed.",
    no_account: "The bank account couldn't be found.",
    authentication_required: "The bank asked for extra verification that wasn't completed.",
  };
  return map[code] || (err.message ? String(err.message).slice(0, 200) : "The payment was declined.");
}

/**
 * Should this webhook event send a "payment failed" email? Pure.
 * session: the Checkout Session (payment_intent expanded or an id);
 * pi: the PaymentIntent if fetched.
 */
export function failureOf(eventType, session, pi = null) {
  if (!session || session.mode && session.mode !== "payment") return null;
  if (session.payment_status === "paid") return null;
  if (eventType === "checkout.session.async_payment_failed") return { kind: "bank", error: pi?.last_payment_error || null };
  if (eventType === "checkout.session.expired") {
    const err = pi?.last_payment_error;
    if (!err) return null; // closed the page without trying — not a failed payment
    return { kind: err.type === "card_error" ? "card" : "other", error: err };
  }
  return null;
}

/** "Ruby Isla Thornburgh — Nepal 2028" → { student, trip }. Pure. */
export function splitDealName(name) {
  const m = /^(.*?)\s+[—–-]\s+(.+)$/.exec(String(name || "").trim());
  return m ? { student: m[1].trim(), trip: m[2].trim() } : { student: String(name || "").trim(), trip: "" };
}

let _stripe = null;
/** Tests inject a Stripe getter. */
export function __setStripe(fn) { _stripe = fn; }

async function paymentIntent(session) {
  const pi = session.payment_intent;
  if (pi && typeof pi === "object") return pi;
  if (!pi) return null;
  if (_stripe) return _stripe(pi);
  const key = process.env.STRIPE_SECRET_KEY;
  const res = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(pi)}`, { headers: { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" } });
  return res.ok ? res.json() : null;
}

/** Emails of the contacts on a HubSpot deal (student + parents). */
async function dealPeople(dealId) {
  if (!/^\d+$/.test(String(dealId || ""))) return { name: "", emails: [] };
  const deal = await HS.getDeal(dealId, ["dealname"]).catch(() => null);
  const assoc = await HS.hs(`/crm/v4/objects/deals/${dealId}/associations/contacts?limit=50`).catch(() => null);
  const ids = (assoc?.results || []).map((r) => String(r.toObjectId));
  let emails = [];
  if (ids.length) {
    const r = await HS.hs(`/crm/v3/objects/contacts/batch/read`, { method: "POST", body: { properties: ["email"], inputs: ids.map((id) => ({ id })) } }).catch(() => null);
    emails = (r?.results || []).map((c) => String(c.properties?.email || "").toLowerCase()).filter((e) => EMAIL_RE.test(e));
  }
  return { name: deal?.properties?.dealname || "", emails };
}

async function once(sessionId) {
  const key = `payment-failed/${sessionId}`;
  try {
    if (await store().get(key)) return false;
    await store().set(key, new Date().toISOString());
  } catch (e) { console.warn("[payment-failed] marker", e.message); }
  return true;
}

/**
 * Handle one Stripe event. Returns what it did (for logs/tests); never throws
 * for email problems. `markDepositFailed` is applications.applySession.
 */
export async function handlePaymentFailure(eventType, session, { markDepositFailed } = {}) {
  if (!flag("UE_PAYMENT_FAILED_EMAILS", true)) return { skipped: "off" };
  const pi = await paymentIntent(session).catch(() => null);
  const failure = failureOf(eventType, session, pi);
  if (!failure) return { skipped: "not a failed payment" };
  if (!(await once(session.id))) return { skipped: "already sent" };

  const amount = moneyText(session.amount_total, session.currency);
  const reason = reasonText(failure.error);
  const payer = String(session.customer_details?.email || session.customer_email || "").toLowerCase();
  let to = []; let cc = []; let student = ""; let studentFirst = ""; let trip = ""; let link = ""; let what = "payment"; let schema = null; let staffLink = "";

  if (session.metadata?.source === "ue-apply") {
    // An application deposit.
    const app = await appById(session.metadata.application_id);
    if (!app) return { skipped: "application not found" };
    if (markDepositFailed && app.deposit?.status !== "paid") await markDepositFailed(session, { failed: true }).catch(() => {});
    schema = (await publishedSchema({ kind: app.kind }).catch(() => ({}))).schema || null;
    const n = app.answers?.name || {};
    student = [n.first, n.middle, n.last].filter(Boolean).join(" ") || [app.first_name, app.last_name].filter(Boolean).join(" ") || app.email;
    studentFirst = n.first || app.first_name || "there";
    trip = app.program_name || "";
    what = "deposit";
    // A fresh continue link (it replaces the old one, which is fine: they need to come back to pay).
    const token = newToken();
    await q(`UPDATE ue_applications SET token_hash = $2, updated_at = now() WHERE id = $1`, [app.id, hashToken(token)]);
    link = `${siteUrl()}/${app.trip_slug}?t=${encodeURIComponent(token)}`;
    to = [app.email];
    cc = [app.answers?.parent1Email, app.answers?.parent2Email, payer];
    staffLink = `${process.env.DASHBOARD_URL || "https://dashboard.pacificdiscovery.org"}/ue-apply-form/#app=${app.id}`;
    await noteSync(app.id, "paymentFailed", { ok: true, reason, amount }).catch(() => {});
  } else {
    // A payment made in the student or leader portal.
    const dealId = session.metadata?.hubspot_deal_id || null;
    // Wording from the student form's "Payment failed" email, if it's been edited.
    schema = (await publishedSchema().catch(() => ({}))).schema || null;
    const people = await dealPeople(dealId);
    const names = splitDealName(people.name);
    student = names.student || "your student";
    studentFirst = (names.student || "").split(/\s+/)[0] || "there";
    trip = names.trip || "your Unearthed trip";
    link = process.env.UE_PORTAL_URL || "https://portal.unearthededucation.org";
    to = payer ? [payer] : people.emails.slice(0, 1);
    cc = people.emails;
    staffLink = dealId ? `https://app.hubspot.com/contacts/${process.env.HUBSPOT_PORTAL_ID || "3855728"}/record/0-3/${dealId}` : "";
  }

  const clean = (list) => [...new Set(list.map((e) => String(e || "").trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))];
  to = clean(to);
  cc = clean(cc).filter((e) => !to.includes(e));
  let sent = { skipped: "no recipient" };
  if (to.length) {
    sent = await N.sendKind("paymentFailed", { to, cc, schema, vars: { student, studentFirst, trip, amount, reason, link, what } })
      .catch((e) => ({ skipped: e.message }));
  }
  await N.alertStaff(`Payment failed — ${student} (${trip || "Unearthed"})`, [
    `A ${amount} ${what === "deposit" ? "deposit" : "portal payment"} for ${student}${trip ? ` (${trip})` : ""} didn't go through.`,
    `Reason: ${reason}`,
    failure.kind === "bank" ? "It was a bank debit that failed after checkout — the family may think it's paid." : "The checkout ended without a successful payment.",
    to.length ? `Emailed: ${[...to, ...cc].join(", ")}${sent.skipped ? ` (NOT sent: ${sent.skipped})` : ""}` : "No email address to tell the family — please contact them.",
    staffLink ? `Details: ${staffLink}` : "",
    `Stripe: https://dashboard.stripe.com/payments/${typeof session.payment_intent === "object" ? session.payment_intent?.id : session.payment_intent || ""}`,
  ]).catch(() => {});
  return { sent: !sent.skipped, to, cc, kind: failure.kind, what, reason };
}
