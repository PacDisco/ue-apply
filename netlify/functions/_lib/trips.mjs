// A "trip" = one HubSpot Unearthed Program record (custom object 2-58156993,
// e.g. "Otago Boys High School - Borneo 2027") plus its launch link in Neon
// (ue_apply_trips, edited on the dashboard's Trips tab).
//
// The trip decides everything the applicant doesn't choose: which program they
// join, the school, the deal name, the deposit (payment_amount_1 — the same
// schedule the Unearthed portal charges from) and the currency.

import { q } from "./db.mjs";
import * as HS from "./hubspot.mjs";

export const PROGRAM_OBJECT = process.env.UE_PROGRAM_OBJECT_TYPE || "2-58156993";
export const GLOBAL_PROGRAM_ID = "50506535214"; // "Global Portal Information" defaults record
const SCHEDULE = Array.from({ length: 15 }, (_, i) => `payment_amount_${i + 1}`);
const PROPS = ["unearthed_program", "program_currency", "school_collecting_payments", ...SCHEDULE];

const _cache = new Map();
const TTL = 60 * 1000;
export function __clearTripCache() { _cache.clear(); }

const money = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };
const truthy = (v) => ["true", "yes", "1", "on"].includes(String(v ?? "").trim().toLowerCase());

/** "Otago Boys High School - Borneo 2027" → { school, destination }. */
export function splitProgramName(name) {
  const s = String(name || "").trim();
  const m = /^(.*?)\s+[-–—]\s+(.+)$/.exec(s);
  return m ? { school: m[1].trim(), destination: m[2].trim() } : { school: "", destination: s };
}

/**
 * Pure: combine the Neon row, the program record and the global defaults.
 * Unset schedule rows / currency fall back to the global record, exactly like
 * the Unearthed portal's payment schedule.
 */
export function buildTrip(row, program, global, { paidCount = 0, today = new Date().toISOString().slice(0, 10) } = {}) {
  const p = program?.properties || {};
  const g = global?.properties || {};
  const schedule = [];
  for (const k of SCHEDULE) {
    const v = money(p[k]) ?? money(g[k]);
    if (v != null) schedule.push(v);
  }
  const name = row.program_name || p.unearthed_program || "";
  const parts = splitProgramName(name);
  const deposit = money(row.deposit) ?? (money(p.payment_amount_1) ?? money(g.payment_amount_1));
  const currency = String(row.currency || p.program_currency || g.program_currency || "NZD").trim().toUpperCase();
  const total = schedule.length ? Math.round(schedule.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  let closedReason = null;
  if (!row.open) closedReason = "closed";
  else if (row.closes_on && String(row.closes_on).slice(0, 10) < today) closedReason = "date";
  else if (row.capacity && paidCount >= Number(row.capacity)) closedReason = "full";
  return {
    slug: row.slug,
    programId: String(row.program_id),
    name,
    school: row.school || parts.school,
    destination: row.destination || parts.destination,
    currency,
    deposit,
    total,
    schoolCollecting: truthy(p.school_collecting_payments),
    open: !closedReason,
    closedReason,
  };
}

export async function tripBySlug(slug, { fresh = false } = {}) {
  const s = String(slug || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(s)) return null;
  const hit = _cache.get(s);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.trip;
  const [row] = await q(`SELECT * FROM ue_apply_trips WHERE slug = $1`, [s]);
  if (!row) return null;
  const [program, global, counts] = await Promise.all([
    HS.getObject(PROGRAM_OBJECT, row.program_id, PROPS),
    HS.getObject(PROGRAM_OBJECT, GLOBAL_PROGRAM_ID, PROPS).catch(() => null),
    q(`SELECT count(*)::int AS n FROM ue_applications WHERE trip_slug = $1 AND status = 'paid'`, [s]),
  ]);
  if (!program) throw Object.assign(new Error(`The HubSpot program record for "${s}" wasn't found.`), { status: 503 });
  const trip = buildTrip(row, program, global, { paidCount: counts[0]?.n || 0 });
  _cache.set(s, { at: Date.now(), trip });
  return trip;
}

/** What the applicant's browser may see. */
export function publicTrip(t) {
  if (!t) return null;
  return {
    slug: t.slug, name: t.name, school: t.school, destination: t.destination,
    currency: t.currency, deposit: t.deposit, schoolCollecting: t.schoolCollecting,
    open: t.open, closedReason: t.closedReason,
  };
}
