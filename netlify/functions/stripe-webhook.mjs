// /api/stripe-webhook — Unearthed's Stripe account.
//   Deposits (sessions this site created, metadata.source = "ue-apply"):
//   paid / processing / failed are recorded on the application.
//   EVERY failed payment on the account — deposits and student / leader
//   portal payments — emails the family and the team (_lib/payment-failed.mjs).
//   Successful portal payments are left to the dashboard's payment sync.
//
// Events: checkout.session.completed, checkout.session.async_payment_succeeded,
//         checkout.session.async_payment_failed, checkout.session.expired
import * as ST from "./_lib/stripe.mjs";
import { applySession } from "./_lib/applications.mjs";
import { handlePaymentFailure } from "./_lib/payment-failed.mjs";
import { json } from "./_lib/http.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const payload = await req.text();
  let event;
  try { event = ST.verifyWebhook(payload, req.headers.get("stripe-signature")); }
  catch (e) { return json({ error: e.message }, 400); }
  try {
    const s = event.data?.object;
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") await applySession(s);
    else if (event.type === "checkout.session.async_payment_failed") {
      await applySession(s, { failed: true });
      console.log("[stripe-webhook] payment failed", s?.id, JSON.stringify(await handlePaymentFailure(event.type, s)));
    } else if (event.type === "checkout.session.expired") {
      console.log("[stripe-webhook] checkout expired", s?.id, JSON.stringify(await handlePaymentFailure(event.type, s, { markDepositFailed: applySession })));
    }
    return json({ received: true });
  } catch (e) {
    console.error("[stripe-webhook]", e);
    return json({ error: "failed" }, 500); // Stripe retries
  }
};

export const config = { path: "/api/stripe-webhook" };
