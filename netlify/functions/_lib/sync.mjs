// Pushes an application out to HubSpot and Jotform. Every target is tried on
// its own and its result recorded in ue_applications.sync, so one failure
// (say Jotform is down) never blocks the others, and the dashboard's
// "Retry sync" can re-run just what failed. Re-running is safe: contacts are
// found by email, the deal id is stored, associations are idempotent, and the
// Jotform submission is updated rather than duplicated.
//
//   contact   student contact (name, email, DOB, mobile + any field mapped to a
//             contact property in the dashboard); company tag "Unearthed Education"
//   parents   primary / secondary contact → contacts, labelled Parent to the student
//   deal      "Unearthed Education" pipeline → Application Complete, amount =
//             the trip's payment schedule total, named "<Student> — <Destination>"
//   program   student (Student), parents (Parent) and deal → the Unearthed
//             Program record — what both portals use for access
//   jotform   the application as a submission in the live Jotform form, so the
//             portals (and leader edits) keep working unchanged

import * as K from "../../../public/form-kit.mjs";
import * as HS from "./hubspot.mjs";
import * as JF from "./jotform.mjs";
import { q, noteSync } from "./db.mjs";
import { fileUrl, flag } from "./http.mjs";
import { PROGRAM_OBJECT } from "./trips.mjs";

export const UE_PIPELINE = process.env.UE_DEAL_PIPELINE || "836668844"; // "Unearthed Education"
const COMPANY_TAG = process.env.UE_COMPANY_TAG || "Unearthed Education";
const STUDENT_LABEL = process.env.UE_STUDENT_LABEL || "Student";
const PARENT_LABEL = process.env.UE_PARENT_LABEL || "Parent";
export const TEACHER_LABEL = process.env.UE_TEACHER_LABEL || "Teacher";
export const TRIP_LEADER_LABEL = process.env.UE_TRIP_LEADER_LABEL || "Trip Leader";

const nameOf = (v) => (v && typeof v === "object" ? { first: String(v.first || "").trim(), last: String(v.last || "").trim() } : splitName(v));
export function splitName(s) {
  const parts = String(s || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

/** The deal name, same pattern as the deals created by hand: "Ruby Isla Thornburgh — Nepal 2028". */
export function dealName(app, trip) {
  const n = nameOf(app.answers?.name);
  const who = [n.first, n.last].filter(Boolean).join(" ") || [app.first_name, app.last_name].filter(Boolean).join(" ") || app.email;
  return `${who} — ${trip?.destination || app.program_name || "Unearthed"}`;
}

/** Contact properties from the dashboard's field mappings (field.hubspot.contact). */
export function mappedContactProps(schema, answers) {
  const out = {};
  for (const { field } of K.allFields(schema)) {
    const m = field.hubspot?.contact;
    if (!m || !K.isInput(field)) continue;
    const v = answers?.[field.key];
    if (v == null || K.isEmptyValue(field, v)) continue;
    if (typeof m === "object") {
      if (field.type === "fullname") { if (m.first) out[m.first] = v.first; if (m.last) out[m.last] = v.last; }
      continue;
    }
    out[m] = field.type === "date" ? String(v) : K.valueText(field, v);
  }
  return out;
}

export function studentProps(schema, app) {
  const a = app.answers || {};
  const n = nameOf(a.name);
  const props = {
    firstname: n.first || app.first_name,
    lastname: n.last || app.last_name,
    ...(a.dob ? { date_of_birth: String(a.dob) } : {}),
    ...(a.mobile ? { phone: K.phoneText(a.mobile) } : {}),
    ...mappedContactProps(schema, a),
  };
  delete props.email;
  return props;
}

/** Parents/guardians from the emergency-contact fields. */
export function parentsOf(app) {
  const a = app.answers || {};
  const out = [];
  for (const i of [1, 2]) {
    const email = String(a[`parent${i}Email`] || "").trim().toLowerCase();
    if (!email || !email.includes("@") || email === String(app.email || "").toLowerCase()) continue;
    const n = nameOf(a[`parent${i}Name`]);
    out.push({
      email,
      props: { firstname: n.first, lastname: n.last, ...(a[`parent${i}Phone`] ? { phone: K.phoneText(a[`parent${i}Phone`]) } : {}) },
    });
  }
  return out;
}

async function step(app, target, fn, out) {
  try {
    const r = await fn();
    await noteSync(app.id, target, { ok: true, ...(r && typeof r === "object" ? r : {}) });
    out[target] = { ok: true, ...(r || {}) };
  } catch (e) {
    console.warn(`[ue-apply sync] ${target}`, app.id, e.message);
    await noteSync(app.id, target, { ok: false, error: String(e.message).slice(0, 400) });
    out[target] = { ok: false, error: e.message };
  }
}

/** Student contact only (after "About you"). Returns the contact id. */
export async function syncContact(app, schema) {
  const out = {};
  await step(app, "contact", async () => {
    const r = await HS.upsertContact(app.email, studentProps(schema, app), { ifEmpty: { company_tag: COMPANY_TAG } });
    await q(`UPDATE ue_applications SET hubspot_contact_id = $2 WHERE id = $1`, [app.id, r.id]);
    app.hubspot_contact_id = r.id;
    return { id: r.id, created: r.created };
  }, out);
  return out.contact;
}

/**
 * Everything, after the full application. `only` limits to some targets
 * (dashboard retry). Returns { [target]: { ok, ... } }.
 */
export async function syncApplication(app, { schema, trip, only = null, waiverSigned = false } = {}) {
  const out = {};
  const want = (t) => !only || only.includes(t);
  const hubspotOn = flag("HUBSPOT_SYNC", true);

  if (hubspotOn && (want("contact") || !app.hubspot_contact_id)) await syncContact(app, schema).then((r) => { out.contact = r; });
  const contactId = app.hubspot_contact_id;

  // Teachers: their contact only. No parents, no deal, nothing in Jotform —
  // and NOT linked to the trip until staff approve them (approveTeacher):
  // the "Teacher" label on the trip opens the leader portal.
  if (app.kind === "teacher") return out;

  let parentIds = Array.isArray(app.hubspot_parent_ids) ? app.hubspot_parent_ids : [];
  if (hubspotOn && contactId && want("parents")) {
    await step(app, "parents", async () => {
      const ids = [];
      for (const p of parentsOf(app)) {
        const r = await HS.upsertContact(p.email, p.props, { ifEmpty: { company_tag: COMPANY_TAG } });
        ids.push(r.id);
        await HS.associate("contacts", r.id, "contacts", contactId, PARENT_LABEL);
      }
      parentIds = ids;
      await q(`UPDATE ue_applications SET hubspot_parent_ids = $2 WHERE id = $1`, [app.id, JSON.stringify(ids)]);
      app.hubspot_parent_ids = ids;
      return { ids };
    }, out);
  }

  if (hubspotOn && contactId && want("deal")) {
    await step(app, "deal", async () => {
      let dealId = app.hubspot_deal_id;
      let created = false;
      if (dealId && !(await HS.getDeal(dealId))) dealId = null; // deleted in HubSpot
      if (!dealId) {
        // Reuse an open UE deal for this student and trip (e.g. made by hand
        // on UE Applications) rather than creating a second one.
        const name = dealName(app, trip).toLowerCase();
        const existing = (await HS.contactDealsInPipeline(contactId, UE_PIPELINE))
          .find((d) => String(d.properties?.dealname || "").trim().toLowerCase() === name);
        if (existing) dealId = String(existing.id);
      }
      if (!dealId) {
        const stage = await HS.stageId(UE_PIPELINE, /application\s*complete/i);
        dealId = await HS.createDeal({
          dealname: dealName(app, trip),
          pipeline: UE_PIPELINE,
          ...(stage ? { dealstage: stage } : {}),
          ...(trip?.total ? { amount: String(trip.total) } : {}),
        });
        created = true;
      }
      await q(`UPDATE ue_applications SET hubspot_deal_id = $2 WHERE id = $1`, [app.id, dealId]);
      app.hubspot_deal_id = dealId;
      await HS.associate("deals", dealId, "contacts", contactId);
      for (const pid of parentIds) await HS.associate("deals", dealId, "contacts", pid);
      return { id: dealId, created };
    }, out);
  }

  if (hubspotOn && contactId && app.program_id && want("program")) {
    await step(app, "program", async () => {
      await HS.associate("contacts", contactId, PROGRAM_OBJECT, app.program_id, STUDENT_LABEL);
      for (const pid of parentIds) await HS.associate("contacts", pid, PROGRAM_OBJECT, app.program_id, PARENT_LABEL);
      if (app.hubspot_deal_id) await HS.associate("deals", app.hubspot_deal_id, PROGRAM_OBJECT, app.program_id);
      return { programId: app.program_id };
    }, out);
  }

  if (want("jotform") && flag("JOTFORM_MIRROR", true)) {
    const formId = schema?.settings?.jotform?.formId || process.env.UE_JOTFORM_FORM_ID;
    if (formId) await step(app, "jotform", () => mirrorToJotform(app, { schema, trip, formId, waiverSigned }), out);
  }
  return out;
}

export async function mirrorToJotform(app, { schema, trip, formId, waiverSigned }) {
  const files = await q(`SELECT id, field_key FROM ue_apply_files WHERE app_id = $1`, [app.id]);
  const known = new Set(files.map((f) => String(f.id)));
  const values = K.computeDerived(schema, app.answers || {}, { trip, waiverSigned: waiverSigned || app.waiver?.status === "signed" });
  // Only files that really belong to this application.
  for (const { field } of K.allFields(schema)) {
    if (field.type === "file" && Array.isArray(values[field.key])) values[field.key] = values[field.key].filter((f) => known.has(String(f.id)));
  }
  const params = K.toJotformParams(schema, values, { fileUrl });
  if (app.jotform_submission_id) {
    await JF.updateSubmission(app.jotform_submission_id, params);
    return { id: app.jotform_submission_id, updated: true };
  }
  const sid = await JF.createSubmission(formId, params);
  // The Jotform ID becomes the application's permanent submission ID — it's
  // the ID the portals have seen for it (see /api/jotform).
  await q(`UPDATE ue_applications SET jotform_submission_id = $2, submission_id = $2 WHERE id = $1`, [app.id, sid])
    .catch(async (err) => {
      // Before MIGRATION-ue-apply-submission-ids.sql has been run.
      if (!/submission_id/.test(String(err?.message))) throw err;
      await q(`UPDATE ue_applications SET jotform_submission_id = $2 WHERE id = $1`, [app.id, sid]);
    });
  app.submission_id = sid;
  app.jotform_submission_id = sid;
  return { id: sid, created: true };
}

/**
 * Staff approval of a teacher: link their contact to the trip's Unearthed
 * Program record with the Teacher label — which is what lets them into the
 * leader portal (rosters, medical and passport details). Idempotent.
 */
export async function approveTeacher(app, { actor, schema, role = null } = {}) {
  if (app.kind !== "teacher") throw Object.assign(new Error("Only teacher applications can be approved."), { status: 400 });
  if (!app.step2_at) throw Object.assign(new Error("They haven't finished the application yet."), { status: 409 });
  if (!app.program_id) throw Object.assign(new Error("This application isn't linked to a trip."), { status: 409 });
  if (!app.hubspot_contact_id) await syncContact(app, schema);
  if (!app.hubspot_contact_id) throw Object.assign(new Error("Their HubSpot contact couldn't be created — try Retry sync."), { status: 502 });
  // The role they applied for (their link), unless staff choose the other one.
  const asLeader = /leader/i.test(String(role || app.role || ""));
  const label = asLeader ? TRIP_LEADER_LABEL : TEACHER_LABEL;
  const r = await HS.associate("contacts", app.hubspot_contact_id, PROGRAM_OBJECT, app.program_id, label);
  if (!r?.label) throw Object.assign(new Error(`HubSpot has no "${label}" association label between contacts and Unearthed Programs, so they were linked without it (no leader-portal access). Check the label name (${asLeader ? "UE_TRIP_LEADER_LABEL" : "UE_TEACHER_LABEL"}).`), { status: 502 });
  const approval = { at: new Date().toISOString(), by: actor || null, programId: String(app.program_id), label };
  const [row] = await q(`UPDATE ue_applications SET approval = $2, updated_at = now() WHERE id = $1 RETURNING *`, [app.id, JSON.stringify(approval)]);
  await noteSync(app.id, "teacher", { ok: true, programId: String(app.program_id), label });
  return row;
}
