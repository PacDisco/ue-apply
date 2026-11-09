// Stripe for the deposit — Unearthed's own Stripe account (STRIPE_SECRET_KEY
// on this site = the same key the Unearthed portal uses).
//
// Card carries the card fee (default 3%, set in the dashboard); bank debit has
// no fee and is offered where the currency has a bank-debit method enabled on
// the account (NZD → NZ bank account, like the portal). The payment carries
// hubspot_deal_id + base_amount, so the dashboard's payment sync logs exactly
// the deposit (without the fee) against exactly this student's deal and moves
// it to Deposit Paid.
import crypto from "node:crypto";

const API = "https://api.stripe.com/v1";
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);

// Same map as the portal's _shared/currency.js. Only methods enabled on the
// Stripe account work; UE_BANK_DEBIT_CURRENCIES limits it (default NZD only).
const BANK_METHOD = { NZD: "nz_bank_account", USD: "us_bank_account", AUD: "au_becs_debit", GBP: "bacs_debit", EUR: "sepa_debit", CAD: "acss_debit" };
export function bankMethodFor(currency, env = process.env) {
  const allowed = String(env.UE_BANK_DEBIT_CURRENCIES || "NZD").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const c = String(currency || "").toUpperCase();
  return allowed.includes(c) ? BANK_METHOD[c] || null : null;
}

export const minorUnits = (amount, currency) => Math.round(Number(amount) * (ZERO_DECIMAL.has(String(currency).toUpperCase()) ? 1 : 100));

let _fetch = (...a) => fetch(...a);
export function __setFetch(f) { _fetch = f; }

async function stripe(path, { method = "GET", params } = {}) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  const res = await _fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20", ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: params ? params.toString() : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${data?.error?.message || "request failed"}`);
  return data;
}

/**
 * Checkout Session for the deposit.
 * @param {{ app, trip, method: 'card'|'bank', charge: { base, total }, successUrl, cancelUrl }} o
 */
export async function createDepositSession({ app, trip, method, charge, successUrl, cancelUrl }) {
  const currency = String(trip.currency || "NZD").toLowerCase();
  const p = new URLSearchParams();
  p.append("mode", "payment");
  p.append("customer_email", app.email);
  p.append("client_reference_id", app.id);
  if (method === "bank") {
    const m = bankMethodFor(trip.currency);
    if (!m) throw Object.assign(new Error("Bank payment isn't available for this currency — please pay by card."), { status: 400 });
    p.append("payment_method_types[0]", m);
  } else {
    p.append("payment_method_types[0]", "card");
  }
  p.append("line_items[0][quantity]", "1");
  p.append("line_items[0][price_data][currency]", currency);
  p.append("line_items[0][price_data][unit_amount]", String(minorUnits(charge.total, currency)));
  p.append("line_items[0][price_data][product_data][name]", `Program deposit — ${trip.name || "Unearthed Education"}`);
  p.append("success_url", successUrl);
  p.append("cancel_url", cancelUrl);
  const meta = {
    source: "ue-apply",
    application_id: app.id,
    contact_email: app.email,
    payment_index: "1",
    payment_kind: "deposit",
    base_amount: String(charge.base),
    charge_amount: String(charge.total),
    currency: String(trip.currency || "").toUpperCase(),
    payment_type: method === "bank" ? "direct_debit" : "card",
    trip: trip.slug,
    ...(app.hubspot_deal_id ? { hubspot_deal_id: String(app.hubspot_deal_id) } : {}),
  };
  for (const [k, v] of Object.entries(meta)) {
    p.append(`metadata[${k}]`, v);
    p.append(`payment_intent_data[metadata][${k}]`, v);
  }
  p.append("payment_intent_data[description]", `Unearthed deposit — ${[app.first_name, app.last_name].filter(Boolean).join(" ")} — ${trip.name || ""}`.trim());
  return stripe("/checkout/sessions", { method: "POST", params: p });
}

export async function getSession(id) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(String(id || ""))) return null;
  return stripe(`/checkout/sessions/${id}?expand[]=payment_intent`);
}

/** Verifies a Stripe-Signature header. Returns the parsed event or throws. */
export function verifyWebhook(payload, header, secret = process.env.STRIPE_WEBHOOK_SECRET, toleranceSec = 600) {
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  const parts = Object.fromEntries(String(header || "").split(",").map((kv) => kv.split("=")).filter((x) => x.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header || "").split(",").filter((x) => x.trim().startsWith("v1=")).map((x) => x.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) throw new Error("Bad signature header");
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) throw new Error("Signature too old");
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new Error("Signature mismatch");
  return JSON.parse(payload);
}
