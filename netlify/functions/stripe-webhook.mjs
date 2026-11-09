// /api/stripe-webhook — Unearthed's Stripe account. Only sessions this site
// created (metadata.source = "ue-apply") are acted on; the portal's own
// checkouts are ignored here (the dashboard's payment sync logs every payment).
//
// Events: checkout.session.completed, checkout.session.async_payment_succeeded,
//         checkout.session.async_payment_failed
import * as ST from "./_lib/stripe.mjs";
import { applySession } from "./_lib/applications.mjs";
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
    else if (event.type === "checkout.session.async_payment_failed") await applySession(s, { failed: true });
    return json({ received: true });
  } catch (e) {
    console.error("[stripe-webhook]", e);
    return json({ error: "failed" }, 500); // Stripe retries
  }
};

export const config = { path: "/api/stripe-webhook" };
