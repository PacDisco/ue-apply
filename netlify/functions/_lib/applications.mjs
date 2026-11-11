// The application flow, start to deposit.
//
//   1 About you      start()     → row + resume token, HubSpot contact
//   2 Application    submit()    → validated answers; HubSpot contacts, deal and
//                                  program links; Jotform submission (portals)
//   3 Permissions    sign()      → a parent signs here, or sendForSignature()
//                                  emails them a link to sign (and then pay)
//                                  from their own device; PDF to HubSpot;
//                                  Jotform "signed the permissions packet" ticked
//   4 Deposit        checkout()  → Stripe — only once a parent has signed (every
//                                  student is under 18). From the student's
//                                  link or the parent's signing link.
//                                  confirmDeposit()/webhook marks it paid (the
//                                  dashboard payment sync logs it on the deal)
//
// Statuses: started → applied → signed → paid. A trip whose school collects
// payments skips step 4. The applicant's browser holds a random token; only
// its sha256 is stored.
//
// Teachers (kind "teacher", link /<trip>/teacher, their own form): about you →
// application → they sign the waiver themselves → done. No parents, no
// deposit, no deal. Staff approve them on the dashboard, which is what gives
// them the "Teacher" label on the trip (and so the leader portal).

import * as K from "../../../public/form-kit.mjs";
import * as W from "../../../public/waiver-kit.mjs";
import { q, publishedSchema, appByToken, appById, noteSync, kindOf } from "./db.mjs";
import { newToken, hashToken, siteUrl, bad } from "./http.mjs";
import { tripBySlug, publicTrip } from "./trips.mjs";
import * as Sync from "./sync.mjs";
import * as N from "./notify.mjs";
import * as HS from "./hubspot.mjs";
import * as ST from "./stripe.mjs";
import { waiverPdf } from "./pdf.mjs";

const today = () => new Date().toISOString().slice(0, 10);
const studentName = (app) => {
  const n = app.answers?.name;
  return (n && typeof n === "object" ? [n.first, n.middle, n.last] : [app.first_name, app.last_name]).filter(Boolean).join(" ").trim() || app.email;
};
const firstName = (app) => (app.answers?.name?.first || app.first_name || "").trim();
export const isTeacher = (app) => app?.kind === "teacher";
/** Teacher-form roles, by link: /<trip>/teacher and /<trip>/leader. */
export const roleOf = (r) => (/leader/i.test(String(r || "")) ? "Trip Leader" : "Teacher");
const rolePath = (app) => (roleOf(app?.role) === "Trip Leader" ? "/leader" : "/teacher");
export const isUnder18 = (app) => { if (isTeacher(app)) return false; const a = K.ageOn(app.answers?.dob, today()); return a == null ? true : a < 18; };
const schemaOf = (app) => publishedSchema({ kind: app?.kind });
const money = (n, cur) => `${cur || ""} ${Number(n).toLocaleString("en-NZ", { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`.trim();
const resumeLink = (slug, token, app) => `${siteUrl()}/${slug}${isTeacher(app) ? rolePath(app) : ""}?t=${encodeURIComponent(token)}`;

/** Where the applicant is up to. */
export function nextStep(app, trip) {
  if (!app.step1_at) return "about";
  if (!app.step2_at) return "application";
  const w = app.waiver?.status;
  if (isTeacher(app)) return w === "signed" ? "done" : "waiver";
  if (w === "sent") return "waiting"; // emailed to a parent, not signed yet
  if (w !== "signed") return "waiver";
  if (trip?.schoolCollecting) return "done";
  if (app.deposit?.status === "paid") return "done";
  return "deposit";
}

/** What the browser gets back: never the waiver signature or other people's data. */
export function stateOf(app, trip) {
  return {
    kind: kindOf(app.kind),
    ...(isTeacher(app) ? { role: roleOf(app.role) } : {}),
    status: app.status,
    step: nextStep(app, trip),
    answers: app.answers || {},
    waiver: app.waiver ? { status: app.waiver.status, parentName: app.waiver.parentName || null, sentTo: app.waiver.sentTo || null, signedAt: app.waiver.signedAt || null } : null,
    deposit: app.deposit ? { status: app.deposit.status, amount: app.deposit.amount, currency: app.deposit.currency, method: app.deposit.method } : null,
    under18: isUnder18(app),
  };
}

async function loadTrip(slug, { requireOpen = false } = {}) {
  const trip = await tripBySlug(slug);
  if (!trip) throw bad("We couldn't find that application link. Please check it with your school.", 404);
  if (requireOpen && !trip.open) throw bad(trip.closedReason === "full" ? "This trip is full." : "Applications for this trip are closed.", 409);
  return trip;
}

async function byToken(token) {
  if (!token || String(token).length < 20) throw bad("Your session has expired — please use the link in your email to continue.", 401);
  const app = await appByToken(hashToken(token));
  if (!app || app.status === "withdrawn") throw bad("Your session has expired — please use the link in your email to continue.", 401);
  return app;
}

// ── public reads ────────────────────────────────────────────────────────────

/** Trip + the published form for a launch link. */
export async function launch(slug, kind = "student") {
  const trip = await loadTrip(slug);
  const k = kindOf(kind);
  const { schema, rev } = await publishedSchema({ kind: k });
  return { kind: k, trip: publicTrip(trip), form: publicForm(schema), rev, prefill: K.prefillValues(schema, { trip }) };
}

/** The schema minus anything the public doesn't need (Jotform/HubSpot mappings stay, they're harmless). */
export function publicForm(schema) {
  const { settings = {} } = schema;
  return {
    steps: schema.steps,
    lists: schema.lists || {},
    waiver: W.waiverOf(schema),
    settings: { cardFeeRate: K.surchargeRates(schema).card, texts: settings.texts || {} },
  };
}

export async function resume(token) {
  const app = await byToken(token);
  const trip = await loadTrip(app.trip_slug);
  const { schema } = await schemaOf(app);
  return { kind: kindOf(app.kind), trip: publicTrip(trip), form: publicForm(schema), app: stateOf(app, trip) };
}

// ── 1. about you ────────────────────────────────────────────────────────────

export async function start({ slug, kind = "student", role = null, values, attribution }) {
  const trip = await loadTrip(slug, { requireOpen: true });
  const k = kindOf(kind);
  const { schema, rev } = await publishedSchema({ kind: k });
  const v = K.validateStep(schema, "step1", { ...K.prefillValues(schema, { trip }), ...(values || {}) });
  if (!v.ok) throw Object.assign(bad("Please check the highlighted fields."), { fields: v.errors });
  const email = String(v.clean.email || "").toLowerCase();

  // Already applied for this trip? Never hand their answers to whoever typed
  // the email — send the continue link to the inbox instead.
  const [existing] = await q(`SELECT * FROM ue_applications WHERE lower(email) = $1 AND trip_slug = $2 AND kind = $3 AND status <> 'withdrawn' ORDER BY created_at DESC LIMIT 1`, [email, trip.slug, k]);
  if (existing) {
    await emailResume(existing, trip, schema);
    return { emailed: true };
  }

  const token = newToken();
  const name = v.clean.name || {};
  const [app] = await q(
    `INSERT INTO ue_applications (token_hash, email, first_name, last_name, trip_slug, program_id, program_name, status, answers, form_rev, step1_at, attribution, kind, role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'started',$8,$9,now(),$10,$11,$12) RETURNING *`,
    [hashToken(token), email, name.first || null, name.last || null, trip.slug, trip.programId, trip.name, JSON.stringify(v.clean), rev, JSON.stringify(cleanAttribution(attribution)), k, k === "teacher" ? roleOf(role) : null]);
  await Sync.syncContact(app, schema).catch(() => {});
  return { token, app: stateOf(app, trip) };
}

function cleanAttribution(a) {
  const out = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "fbclid", "landing", "referrer"]) {
    if (a?.[k]) out[k] = String(a[k]).slice(0, 500);
  }
  return out;
}

async function emailResume(app, trip, schema) {
  const token = newToken();
  await q(`UPDATE ue_applications SET token_hash = $2, updated_at = now() WHERE id = $1`, [app.id, hashToken(token)]);
  await N.sendKind("resume", { to: [app.email], schema, vars: { student: studentName(app), studentFirst: firstName(app) || "there", trip: trip.name, school: trip.school, link: resumeLink(trip.slug, token, app) } })
    .catch((e) => console.warn("[ue-apply] resume email", e.message));
}

/** "Lost your link?" — always the same answer, whether or not we found them. */
export async function requestResume({ slug, email, kind = "student" }) {
  const trip = await loadTrip(slug);
  const k = kindOf(kind);
  const { schema } = await publishedSchema({ kind: k });
  const e = String(email || "").trim().toLowerCase();
  if (e.includes("@")) {
    const [app] = await q(`SELECT * FROM ue_applications WHERE lower(email) = $1 AND trip_slug = $2 AND kind = $3 AND status NOT IN ('withdrawn','imported') ORDER BY created_at DESC LIMIT 1`, [e, trip.slug, k]);
    if (app) await emailResume(app, trip, schema);
  }
  return { ok: true };
}

// ── 2. application ──────────────────────────────────────────────────────────

/** Saves progress without validating (leave and come back). */
export async function saveDraft({ token, values }) {
  const app = await byToken(token);
  if (app.step2_at) return { ok: true }; // submitted answers are only changed by submit
  const { schema } = await schemaOf(app);
  const keep = {};
  for (const f of K.stepFields(schema, "step2")) if (K.isInput(f) && values?.[f.key] !== undefined) keep[f.key] = values[f.key];
  const text = JSON.stringify(keep);
  if (text.length > 200_000) throw bad("That's too much to save at once.", 413);
  await q(`UPDATE ue_applications SET answers = answers || $2::jsonb, updated_at = now() WHERE id = $1`, [app.id, text]);
  return { ok: true };
}

export async function submit({ token, values }) {
  const app = await byToken(token);
  const trip = await loadTrip(app.trip_slug);
  const { schema, rev } = await schemaOf(app);
  const all = { ...(app.answers || {}), ...(values || {}) };
  const v = K.validateStep(schema, "step2", all);
  if (!v.ok) throw Object.assign(bad("Please check the highlighted fields."), { fields: v.errors });
  // Uploaded files must belong to this application.
  const mine = new Set((await q(`SELECT id FROM ue_apply_files WHERE app_id = $1`, [app.id])).map((r) => String(r.id)));
  for (const f of K.stepFields(schema, "step2")) {
    if (f.type === "file" && Array.isArray(v.clean[f.key]) && v.clean[f.key].some((x) => !mine.has(String(x.id)))) {
      throw Object.assign(bad("Please upload that file again."), { fields: { [f.key]: "Please upload that file again." } });
    }
  }
  const step1 = K.validateStep(schema, "step1", all).clean;
  const answers = { ...step1, ...v.clean };
  const first = !app.step2_at;
  const [row] = await q(
    `UPDATE ue_applications SET answers = $2, form_rev = $3, step2_at = coalesce(step2_at, now()),
        status = CASE WHEN status = 'started' THEN 'applied' ELSE status END, updated_at = now()
      WHERE id = $1 RETURNING *`, [app.id, JSON.stringify(answers), rev]);
  const sync = await Sync.syncApplication(row, { schema, trip });
  if (first) {
    const teacher = isTeacher(row);
    const role = roleOf(row.role);
    N.alertStaff(`New Unearthed ${teacher ? `${role.toLowerCase()} ` : ""}application — ${studentName(row)} (${trip.name})`, [
      `${studentName(row)} <${row.email}> applied${teacher ? ` as a ${role.toLowerCase()}` : ""} for ${trip.name}.`,
      ...(teacher ? [`They don't get leader-portal access until you approve them on the dashboard (Applications → Approve as ${role}).`] : []),
      `Dashboard: ${process.env.DASHBOARD_URL || "https://dashboard.pacificdiscovery.org"}/ue-apply-form/#app=${row.id}`,
      teacher ? `HubSpot contact: ${row.hubspot_contact_id ? `https://app.hubspot.com/contacts/${process.env.HUBSPOT_PORTAL_ID || "3855728"}/record/0-1/${row.hubspot_contact_id}` : "not created — check the sync on the dashboard"}` : row.hubspot_deal_id ? `HubSpot deal: https://app.hubspot.com/contacts/${process.env.HUBSPOT_PORTAL_ID || "3855728"}/record/0-3/${row.hubspot_deal_id}` : "HubSpot deal: not created — check the sync on the dashboard",
    ]).catch(() => {});
  }
  return { app: stateOf(row, trip), sync: Object.fromEntries(Object.entries(sync).map(([k, r]) => [k, !!r?.ok])) };
}

// ── uploads ─────────────────────────────────────────────────────────────────

export const UPLOAD_TYPES = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/i;

export async function recordUpload({ token, fieldKey, name, type, size, blobKey }) {
  const app = await byToken(token);
  const [row] = await q(`INSERT INTO ue_apply_files (app_id, field_key, name, type, size, blob_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, size, type`,
    [app.id, fieldKey, String(name).slice(0, 200), type, size, blobKey]);
  return { id: String(row.id), name: row.name, size: row.size, type: row.type };
}

export async function uploadAllowed(token, fieldKey) {
  const app = await byToken(token);
  const { schema } = await schemaOf(app);
  const f = K.fieldByKey(schema, fieldKey);
  if (!f || f.type !== "file") throw bad("That isn't an upload field.");
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM ue_apply_files WHERE app_id = $1`, [app.id]);
  if (n >= 40) throw bad("Too many uploads on this application.", 429);
  return { app, field: f };
}

// ── 3. permissions packet ───────────────────────────────────────────────────

/** Email a parent the signing link (the student can carry on to the deposit). */
export async function sendForSignature({ token, email }) {
  const app = await byToken(token);
  if (isTeacher(app)) throw bad("Teachers sign the waiver themselves — there's nothing to send.");
  if (!app.step2_at) throw bad("Please finish the application first.");
  if (app.waiver?.status === "signed") return { app: stateOf(app, await loadTrip(app.trip_slug)) };
  const trip = await loadTrip(app.trip_slug);
  const { schema } = await schemaOf(app);
  const to = String(email || app.answers?.parent1Email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) throw Object.assign(bad("Please enter your parent or guardian's email."), { fields: { email: "Please enter a valid email address." } });
  if (to === String(app.email).toLowerCase()) throw Object.assign(bad("This needs to go to a parent or guardian, not the student."), { fields: { email: "Use your parent or guardian's email, not yours." } });
  const signToken = newToken();
  const waiver = { ...(app.waiver || {}), status: "sent", sentTo: to, sentAt: new Date().toISOString(), signTokenHash: hashToken(signToken) };
  const [row] = await q(`UPDATE ue_applications SET waiver = $2, updated_at = now() WHERE id = $1 RETURNING *`, [app.id, JSON.stringify(waiver)]);
  const parentName = [app.answers?.parent1Name].map((n) => (n && typeof n === "object" ? n.first : String(n || "").split(/\s+/)[0])).find(Boolean) || "there";
  const r = await N.sendKind("signRequest", { to: [to], schema, vars: { parent: parentName, student: studentName(app), studentFirst: firstName(app), trip: trip.name, school: trip.school, link: `${siteUrl()}/sign?t=${encodeURIComponent(signToken)}` } });
  await noteSync(app.id, "signRequest", { ok: !r.skipped, to, ...(r.skipped ? { error: r.skipped } : {}) });
  return { app: stateOf(row, trip), emailed: !r.skipped };
}

/** For the parent's /sign page. */
export async function signInfo(signToken) {
  const app = await appBySignToken(signToken);
  const trip = await loadTrip(app.trip_slug);
  const { schema } = await schemaOf(app);
  return {
    student: studentName(app), trip: publicTrip(trip), waiver: W.waiverOf(schema), under18: isUnder18(app),
    signed: app.waiver?.status === "signed" ? { parentName: app.waiver.parentName, signedAt: app.waiver.signedAt } : null,
    // After signing, the parent can pay the deposit from the same page.
    next: app.waiver?.status === "signed" ? nextStep(app, trip) : "waiver",
    cardFeeRate: K.surchargeRates(schema).card,
    deposit: app.deposit ? { status: app.deposit.status } : null,
    parent: (() => { const n = app.answers?.parent1Name; return n && typeof n === "object" ? `${n.first || ""} ${n.last || ""}`.trim() : String(n || ""); })(),
  };
}

async function appBySignToken(signToken) {
  if (!signToken || String(signToken).length < 20) throw bad("This signing link isn't valid.", 401);
  const [app] = await q(`SELECT * FROM ue_applications WHERE waiver->>'signTokenHash' = $1 AND status <> 'withdrawn'`, [hashToken(signToken)]);
  if (!app) throw bad("This signing link isn't valid any more — ask the student to send a new one.", 401);
  return app;
}

/** The parent signs — from the student's device (token) or the emailed link (signToken). */
export async function sign({ token, signToken, input, ip, userAgent }) {
  const app = signToken ? await appBySignToken(signToken) : await byToken(token);
  if (!app.step2_at) throw bad("Please finish the application first.");
  if (signToken && isTeacher(app)) throw bad("This signing link isn't valid.", 401);
  const trip = await loadTrip(app.trip_slug);
  const { schema } = await schemaOf(app);
  if (app.waiver?.status === "signed") return { app: stateOf(app, trip), already: true };
  const waiver = W.waiverOf(schema);
  const under18 = isUnder18(app);
  const v = W.validateSignature(waiver, input, { under18, self: isTeacher(app) });
  if (!v.ok) throw Object.assign(bad("Please complete the highlighted parts."), { fields: v.errors });
  const signedAt = new Date().toISOString();
  const record = {
    status: "signed", parentName: v.clean.parentName, relationship: v.clean.relationship, initials: v.clean.initials,
    parts: v.clean.parts, under18, signedAt, ip: ip || null, userAgent: String(userAgent || "").slice(0, 300),
    via: signToken ? "email link" : "applicant's device", sentTo: app.waiver?.sentTo || null,
    // Kept so the emailed link shows "already signed" rather than "invalid".
    ...(app.waiver?.signTokenHash ? { signTokenHash: app.waiver.signTokenHash } : {}),
    // The exact wording they signed, so the PDF can always be rebuilt from it
    // even after the text is edited on the dashboard.
    text: { title: waiver.title, intro: waiver.intro, declaration: waiver.declaration, parts: W.partsFor(waiver, { under18 }) },
  };
  const [row] = await q(
    `UPDATE ue_applications SET waiver = $2, waiver_signature = $3,
        status = CASE WHEN status IN ('started','applied') THEN 'signed' ELSE status END, updated_at = now()
      WHERE id = $1 RETURNING *`, [app.id, JSON.stringify(record), v.clean.signature]);
  await afterSigned(row, { schema, trip, waiver, under18 });
  return { app: stateOf(row, trip) };
}

/** PDF to HubSpot, Jotform "signed" tick, copy to the signer. Failures are recorded, never thrown. */
export async function afterSigned(app, { schema, trip, waiver, under18 }) {
  let bytes = null;
  try {
    bytes = waiverPdf({ waiver: app.waiver?.text?.parts ? app.waiver.text : waiver, under18, student: { name: studentName(app), dob: app.answers?.dob }, trip, signed: { ...app.waiver, signature: app.waiver_signature }, role: isTeacher(app) ? "Teacher" : "Student" });
  } catch (e) { await noteSync(app.id, "waiverPdf", { ok: false, error: e.message }); }
  const fileName = `${isTeacher(app) ? "Teacher waiver" : "Permissions packet"} - ${studentName(app)} - ${trip.destination || trip.name}.pdf`.replace(/[\\/:*?"<>|]/g, "-");
  if (bytes && app.hubspot_contact_id) {
    try {
      const fileId = await HS.uploadFile(bytes, fileName);
      const noteId = await HS.createNote({
        body: `<p><strong>${isTeacher(app) ? "Teacher waiver signed" : "Permissions packet signed"}</strong> — ${trip.name}<br>Signed by ${app.waiver.parentName} (${isTeacher(app) ? "the teacher, for themselves" : app.waiver.relationship}) on ${new Date(app.waiver.signedAt).toLocaleDateString("en-NZ")} via apply.unearthededucation.org. PDF attached.</p>`,
        fileId, contactIds: [app.hubspot_contact_id, ...(app.hubspot_parent_ids || [])], dealId: app.hubspot_deal_id,
      });
      await noteSync(app.id, "waiverPdf", { ok: true, fileId, noteId });
    } catch (e) { await noteSync(app.id, "waiverPdf", { ok: false, error: e.message }); }
  }
  if (!isTeacher(app)) await Sync.syncApplication(app, { schema, trip, only: ["jotform"], waiverSigned: true }).catch(() => {});
  const to = isTeacher(app) ? String(app.email).toLowerCase() : app.waiver.sentTo || String(app.answers?.parent1Email || "").toLowerCase() || null;
  if (to && bytes) {
    N.sendKind("signed", { to: [to], cc: to === String(app.email).toLowerCase() ? [] : [app.email], schema, vars: { parent: app.waiver.parentName.split(/\s+/)[0], student: studentName(app), studentFirst: firstName(app), trip: trip.name }, attachments: [{ filename: fileName, content: Buffer.from(bytes) }] })
      .catch((e) => console.warn("[ue-apply] signed email", e.message));
  }
}

// ── 4. deposit ──────────────────────────────────────────────────────────────

export function depositQuote(schema, trip, method) {
  if (trip.deposit == null) throw bad("The deposit for this trip isn't set up yet — please contact Unearthed (info@unearthededucation.org) and we'll sort it out.", 409);
  return K.withSurcharge(schema, trip.deposit, method === "bank" ? "bank" : "card");
}

/** From the student's resume token or the parent's signing link. */
async function byTokenOrSign({ token, signToken }) {
  return signToken ? appBySignToken(signToken) : byToken(token);
}

export async function checkout({ token, signToken, method }) {
  const app = await byTokenOrSign({ token, signToken });
  const trip = await loadTrip(app.trip_slug);
  const step = nextStep(app, trip);
  if (step === "done") return { done: true, app: stateOf(app, trip) };
  if (step === "waiting" || step === "waiver") throw bad("A parent or guardian needs to sign the permissions packet before the deposit can be paid.", 409);
  if (step !== "deposit") throw bad("Please finish the earlier steps first.");
  if (!trip.open && app.deposit?.status !== "processing") throw bad("Applications for this trip are closed.", 409);
  const { schema } = await schemaOf(app);
  const m = method === "bank" ? "bank" : "card";
  const charge = depositQuote(schema, trip, m);
  if (!app.hubspot_deal_id) await Sync.syncApplication(app, { schema, trip, only: ["contact", "deal"] }).catch(() => {});
  const session = await ST.createDepositSession({
    app, trip, method: m, charge,
    successUrl: `${siteUrl()}/${trip.slug}?paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${siteUrl()}/${trip.slug}?cancelled=1`,
  });
  const deposit = { ...(app.deposit || {}), status: app.deposit?.status === "processing" ? "processing" : "pending", amount: charge.base, charged: charge.total, currency: trip.currency, method: m, sessionId: session.id, startedAt: new Date().toISOString() };
  await q(`UPDATE ue_applications SET deposit = $2, updated_at = now() WHERE id = $1`, [app.id, JSON.stringify(deposit)]);
  return { url: session.url };
}

/**
 * Back from Stripe: check the session ourselves (the webhook does the same).
 * With the student's token → their full state. Without (a parent paid from
 * the signing link, on a device with no student token) → just the outcome.
 */
export async function confirmDeposit({ token, sessionId }) {
  const session = await ST.getSession(sessionId);
  if (!token) {
    if (!session || session.metadata?.source !== "ue-apply") throw bad("We couldn't find that payment.", 404);
    const status = await applySession(session);
    return { payment: { status: status || "pending" } };
  }
  const app = await byToken(token);
  const trip = await loadTrip(app.trip_slug);
  if (session && session.metadata?.application_id === app.id) await applySession(session);
  const fresh = await appById(app.id);
  return { app: stateOf(fresh, trip) };
}

/**
 * Record a Checkout Session's outcome. Idempotent: emails go out only on the
 * transition to paid. Returns the new deposit status or null if not ours.
 */
export async function applySession(session, { failed = false } = {}) {
  if (session?.metadata?.source !== "ue-apply") return null;
  const app = await appById(session.metadata.application_id);
  if (!app) return null;
  const pi = typeof session.payment_intent === "object" ? session.payment_intent?.id : session.payment_intent;
  const base = { ...(app.deposit || {}), sessionId: session.id, paymentIntent: pi || app.deposit?.paymentIntent || null };
  if (failed) {
    await q(`UPDATE ue_applications SET deposit = $2, updated_at = now() WHERE id = $1 AND coalesce(deposit->>'status','') <> 'paid'`, [app.id, JSON.stringify({ ...base, status: "failed", failedAt: new Date().toISOString() })]);
    return "failed";
  }
  if (session.payment_status !== "paid") {
    await q(`UPDATE ue_applications SET deposit = $2, updated_at = now() WHERE id = $1 AND coalesce(deposit->>'status','') NOT IN ('paid')`, [app.id, JSON.stringify({ ...base, status: "processing" })]);
    return "processing";
  }
  const rows = await q(
    `UPDATE ue_applications SET deposit = $2, status = 'paid', updated_at = now()
      WHERE id = $1 AND coalesce(deposit->>'status','') <> 'paid' RETURNING *`,
    [app.id, JSON.stringify({ ...base, status: "paid", paidAt: new Date().toISOString(), amountTotal: (session.amount_total || 0) })]);
  if (rows[0]) await afterPaid(rows[0]).catch((e) => console.warn("[ue-apply] afterPaid", e.message));
  return "paid";
}

async function afterPaid(app) {
  const trip = await tripBySlug(app.trip_slug, { fresh: true });
  const { schema } = await schemaOf(app);
  const parents = [app.answers?.parent1Email, app.answers?.parent2Email].map((e) => String(e || "").toLowerCase()).filter((e) => e.includes("@"));
  const amount = money(app.deposit?.amount, app.deposit?.currency);
  await N.sendKind("deposit", { to: [app.email], cc: parents, schema, vars: { student: studentName(app), studentFirst: firstName(app) || "there", trip: trip?.name || app.program_name, amount, link: process.env.UE_PORTAL_URL || "https://portal.unearthededucation.org" } })
    .catch((e) => console.warn("[ue-apply] deposit email", e.message));
  await N.alertStaff(`Deposit paid — ${studentName(app)} (${trip?.name || app.program_name})`, [
    `${studentName(app)} paid the ${amount} deposit for ${trip?.name || app.program_name}.`,
    app.waiver?.status === "signed" ? "Permissions packet: signed." : `Permissions packet: NOT signed yet${app.waiver?.sentTo ? ` (sent to ${app.waiver.sentTo})` : ""}.`,
    "The payment is logged on the HubSpot deal by the payment sync within about 30 minutes.",
  ]).catch(() => {});
}
