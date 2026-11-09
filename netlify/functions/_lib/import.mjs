// "Add from HubSpot": bring a student who applied on the old Jotform form into
// the Applications list, so everyone for a trip is in one place. Nothing is
// created in HubSpot or Jotform — it links what's already there:
//   contact (by email) → their open deal in the Unearthed Education pipeline
//   → the Unearthed Program they're on (Student label) → their Jotform
//   application (answers copied in, and the submission id kept so a later
//   "Retry sync" updates that submission rather than making a second one).
import * as K from "../../../public/form-kit.mjs";
import * as HS from "./hubspot.mjs";
import * as JF from "./jotform.mjs";
import { q } from "./db.mjs";
import { PROGRAM_OBJECT } from "./trips.mjs";
import { UE_PIPELINE } from "./sync.mjs";
import { bad } from "./http.mjs";

const OLD_FORMS = () => String(process.env.JOTFORM_APPLICATION_FORM_ID || "251396787451873,253477140703050,260388618557066,250747665126866").split(",").map((s) => s.trim()).filter(Boolean);

/** Jotform answer → this form's value shape. Pure (tested). */
export function fromJotformAnswer(field, a) {
  const v = a?.answer;
  if (v == null || v === "") return undefined;
  switch (field.type) {
    case "fullname": return typeof v === "object" ? { first: String(v.first || ""), last: String(v.last || "") } : undefined;
    case "address": return typeof v === "object" ? { addr_line1: v.addr_line1 || "", addr_line2: v.addr_line2 || "", city: v.city || "", state: v.state || "", postal: v.postal || "", country: v.country || "" } : undefined;
    case "date": {
      if (typeof v === "object" && v.year) return `${v.year}-${String(v.month).padStart(2, "0")}-${String(v.day).padStart(2, "0")}`;
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v)) || null;
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
      const d = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(String(v));
      return d ? `${d[3]}-${d[1].padStart(2, "0")}-${d[2].padStart(2, "0")}` : undefined; // Jotform shows MM-DD-YYYY
    }
    case "phone": {
      const full = typeof v === "object" ? (v.full || [v.area, v.phone].filter(Boolean).join(" ")) : String(v);
      const m = /^\+?(\d{1,3})[\s-]+(.+)$/.exec(full.trim());
      return m && full.trim().startsWith("+") ? { cc: m[1], number: m[2] } : { cc: "", number: full.trim() };
    }
    case "checkbox": return Array.isArray(v) ? v.map(String) : String(v).split(/\r?\n/).filter(Boolean);
    case "file": return (Array.isArray(v) ? v : [v]).filter(Boolean).map((url) => ({ id: null, url: String(url), name: decodeURIComponent(String(url).split("/").pop() || "file") }));
    default: return typeof v === "object" ? Object.values(v).filter(Boolean).join(" ") : String(v);
  }
}

export function answersFromSubmission(schema, sub) {
  const out = {};
  for (const { field } of K.allFields(schema)) {
    if (!K.isInput(field) || !field.qid) continue;
    const val = fromJotformAnswer(field, sub?.answers?.[field.qid]);
    if (val !== undefined) out[field.key] = val;
  }
  return out;
}

/** Preview before importing: what we found for this email. */
export async function lookup(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e.includes("@")) throw bad("Enter the student's email.");
  const [existing] = await q(`SELECT id, status, trip_slug FROM ue_applications WHERE lower(email) = $1 AND status <> 'withdrawn' ORDER BY created_at DESC LIMIT 1`, [e]);
  const contact = await HS.findContactByEmail(e);
  if (!contact) return { email: e, existing: existing || null, contact: null, deals: [], programs: [], jotform: null };
  const deals = (await HS.contactDealsInPipeline(contact.id, UE_PIPELINE)).map((d) => ({ id: String(d.id), name: d.properties?.dealname, stage: d.properties?.dealstage, amount: d.properties?.amount }));
  const assoc = await HS.hs(`/crm/v4/objects/contacts/${contact.id}/associations/${PROGRAM_OBJECT}?limit=50`);
  const programIds = (assoc?.results || []).map((r) => String(r.toObjectId));
  const trips = programIds.length ? await q(`SELECT slug, program_id, program_name FROM ue_apply_trips WHERE program_id = ANY($1::text[])`, [programIds]) : [];
  let jotform = null;
  try { const s = await JF.findSubmissionByEmail(OLD_FORMS(), e); if (s) jotform = { id: String(s.id), formId: s.formId, createdAt: s.created_at }; }
  catch (err) { jotform = { error: err.message }; }
  return {
    email: e, existing: existing || null,
    contact: { id: contact.id, name: [contact.properties?.firstname, contact.properties?.lastname].filter(Boolean).join(" ") },
    deals, programs: programIds.map((id) => ({ id, slug: trips.find((t) => t.program_id === id)?.slug || null, name: trips.find((t) => t.program_id === id)?.program_name || null })),
    jotform,
  };
}

export async function importApplicant({ email, slug, dealId, actor, schema }) {
  const info = await lookup(email);
  if (info.existing) throw bad(`Already in the list (${info.existing.status}).`, 409);
  if (!info.contact) throw bad("No HubSpot contact has that email.", 404);
  const [trip] = slug ? await q(`SELECT * FROM ue_apply_trips WHERE slug = $1`, [slug]) : [];
  if (slug && !trip) throw bad("Pick one of the trips on the Trips tab.");
  const programId = trip?.program_id || (info.programs.length === 1 ? info.programs[0].id : null);
  const tripRow = trip || (programId ? (await q(`SELECT * FROM ue_apply_trips WHERE program_id = $1 ORDER BY created_at LIMIT 1`, [programId]))[0] : null);
  if (!tripRow) throw bad("Which trip? Add the trip on the Trips tab first, then pick it here.");
  const deal = dealId ? info.deals.find((d) => d.id === String(dealId)) : info.deals[0];
  let answers = {};
  let sub = null;
  if (info.jotform?.id) {
    sub = await JF.findSubmissionByEmail(OLD_FORMS(), info.email);
    if (sub) answers = answersFromSubmission(schema, sub);
  }
  const name = answers.name || {};
  const [row] = await q(
    `INSERT INTO ue_applications (email, first_name, last_name, trip_slug, program_id, program_name, status, answers,
        hubspot_contact_id, hubspot_deal_id, jotform_submission_id, step1_at, step2_at, imported)
     VALUES ($1,$2,$3,$4,$5,$6,'imported',$7,$8,$9,$10,$11,$11,$12) RETURNING *`,
    [info.email, name.first || info.contact.name.split(" ")[0] || null, name.last || info.contact.name.split(" ").slice(1).join(" ") || null,
      tripRow.slug, tripRow.program_id, tripRow.program_name, JSON.stringify(answers), info.contact.id, deal?.id || null,
      sub?.formId === (schema?.settings?.jotform?.formId || "251396787451873") ? String(sub.id) : null,
      sub?.created_at ? new Date(String(sub.created_at).replace(" ", "T") + "Z").toISOString() : new Date().toISOString(),
      JSON.stringify({ at: new Date().toISOString(), by: actor || null, from: "HubSpot", jotformId: sub ? String(sub.id) : null, jotformForm: sub?.formId || null, dealId: deal?.id || null })]);
  return row;
}
