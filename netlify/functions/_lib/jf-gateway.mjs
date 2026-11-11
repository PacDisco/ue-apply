// The portals' application data source — a Jotform-compatible API in front of
// this site's database, so the Unearthed portals stop depending on Jotform
// without rewriting how they read applications.
//
// The portals call Jotform's REST API (GET /form/{id}/submissions,
// GET|POST /submission/{id}, …) at JOTFORM_BASE_URL. Point that at
// https://apply.unearthededucation.org/api/jotform and:
//
//   • applications made here are served from this database, shaped exactly
//     like Jotform submissions (same field IDs, same answer shapes), and leader
//     edits are saved here;
//   • everything else (old Jotform-only applicants, the document-upload form,
//     form metadata) is passed through to Jotform while JOTFORM_FALLBACK is on.
//
// When every old applicant has been copied in, JOTFORM_FALLBACK=off and the
// portals no longer touch Jotform at all — with no portal change.
//
// This file is the pure part (tested). The HTTP handler is
// netlify/functions/jotform-api.mjs.
import * as K from "../../../public/form-kit.mjs";
import { buildTrip } from "./trips.mjs";

export const APP_FORM_DEFAULT = "251396787451873";

/** The Unearthed application form's Jotform ID (from the published schema). */
export function appFormId(schema) {
  return String(schema?.settings?.jotform?.formId || process.env.UE_JOTFORM_FORM_ID || APP_FORM_DEFAULT);
}

/**
 * Which applications this site serves (instead of Jotform): everyone who
 * finished the application here. Imported (old Jotform) applicants stay with
 * Jotform until they're copied over in full; half-finished ones aren't
 * applications yet (Jotform never had them either).
 */
export const SERVED_SQL = `step2_at IS NOT NULL AND status NOT IN ('imported')`;

/** Jotform's timestamp format ("YYYY-MM-DD HH:MM:SS"). */
export function jfTime(d) {
  if (!d) return null;
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return null;
  return t.toISOString().slice(0, 19).replace("T", " ");
}

/** Trip details for the hidden "program / school / currency" answers, without a HubSpot call. */
export function tripFor(app, tripRow) {
  const row = tripRow || { slug: app.trip_slug, program_id: app.program_id, program_name: app.program_name, open: true };
  const t = buildTrip({ ...row, currency: row.currency || app.deposit?.currency || null }, null, null);
  return t;
}

/** One application as a Jotform submission object. */
export function toSubmission(app, schema, { tripRow = null, fileUrl, formId = appFormId(schema) } = {}) {
  const values = K.computeDerived(schema, app.answers || {}, { trip: tripFor(app, tripRow), waiverSigned: app.waiver?.status === "signed" });
  return {
    id: String(app.submission_id || app.jotform_submission_id),
    form_id: String(formId),
    ip: "",
    created_at: jfTime(app.step2_at || app.created_at),
    updated_at: jfTime(app.updated_at),
    status: app.status === "withdrawn" ? "DELETED" : "ACTIVE",
    new: "0",
    flag: "0",
    notes: "",
    source: "apply.unearthededucation.org",
    answers: K.toJotformAnswers(schema, values, { fileUrl }),
  };
}

/** Jotform's list-envelope. */
export function envelope(content, extra = {}) {
  return { responseCode: 200, message: "success", content, ...extra };
}

/**
 * Merge a page from Jotform with the applications served here.
 *   - a Jotform submission that is one of ours is replaced by ours (ours is the
 *     source of truth: leader edits are saved here first);
 *   - applications Jotform never had (copy turned off, or it failed) go at the
 *     top of the first page — they're the newest.
 * `ours` is [{ app, sub }].
 */
export function mergePage(jfContent, ours, { offset = 0 } = {}) {
  const byJf = new Map();
  for (const o of ours) if (o.app.jotform_submission_id) byJf.set(String(o.app.jotform_submission_id), o.sub);
  const page = (Array.isArray(jfContent) ? jfContent : []).map((s) => byJf.get(String(s?.id)) || s);
  if (Number(offset) > 0) return page;
  const extra = ours.filter((o) => !o.app.jotform_submission_id && o.sub.status !== "DELETED").map((o) => o.sub);
  return [...extra, ...page];
}

/** Our own list (no Jotform): newest first, Jotform's offset/limit. */
export function ownPage(ours, { offset = 0, limit = 20 } = {}) {
  const all = ours.map((o) => o.sub).filter((s) => s.status !== "DELETED")
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const o = Math.max(0, Number(offset) || 0);
  const l = Math.max(1, Math.min(5000, Number(limit) || 20));
  return { content: all.slice(o, o + l), resultSet: { offset: o, limit: l, count: Math.min(l, Math.max(0, all.length - o)) } };
}

// ── edits (POST /submission/{id}) ───────────────────────────────────────────

const ADDRESS_KEYS = ["addr_line1", "addr_line2", "city", "state", "postal", "country"];
const NAME_KEYS = ["first", "middle", "last", "prefix", "suffix"];
const DATE_KEYS = ["day", "month", "year"];

/** "submission[12_first]" | "submission[12][first]" | "submission[12]" → { qid, sub }. */
export function parseEditKey(k) {
  const m = /^submission\[([^\]]+)\](?:\[([^\]]*)\])?$/.exec(String(k));
  if (!m) return null;
  let qid = m[1]; let sub = m[2] ?? null;
  if (sub == null) {
    const u = /^([^_]+)_(.+)$/.exec(qid);
    if (u) { qid = u[1]; sub = u[2]; }
  }
  return { qid, sub: sub === "" ? null : sub };
}

function parsePhone(s) {
  const full = String(s || "").trim();
  const m = /^\+(\d{1,3})[\s-]+(.+)$/.exec(full);
  return m ? { cc: m[1], number: m[2].trim() } : { cc: "", number: full };
}

function parseDate(s) {
  const v = String(s || "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(v); // Jotform shows MM-DD-YYYY
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : v;
}

/**
 * Apply a Jotform-style edit (form-encoded `submission[...]` pairs) to an
 * application's answers. Pure. Returns { answers, changed: [field keys],
 * ignored: [submission keys we don't recognise or don't allow] }.
 * Uploaded files can't be replaced this way (the portals never do).
 */
export function applyEdit(schema, answers, pairs) {
  const out = JSON.parse(JSON.stringify(answers || {}));
  const byQid = new Map();
  for (const { field } of K.allFields(schema)) if (K.isInput(field) && field.qid) byQid.set(String(field.qid), field);
  const changed = new Set(); const ignored = [];

  for (const [k, raw] of pairs) {
    const p = parseEditKey(k);
    const field = p && byQid.get(p.qid);
    if (!field || field.type === "file") { ignored.push(k); continue; }
    const v = String(raw ?? "");
    const key = field.key;
    switch (field.type) {
      case "fullname": {
        const cur = typeof out[key] === "object" && out[key] ? { ...out[key] } : { first: "", last: "" };
        if (p.sub && NAME_KEYS.includes(p.sub)) cur[p.sub] = v.trim();
        else if (!p.sub) { const parts = v.trim().split(/\s+/); cur.first = parts.shift() || ""; cur.last = parts.join(" "); }
        else { ignored.push(k); continue; }
        out[key] = cur; break;
      }
      case "address": {
        if (!p.sub || !ADDRESS_KEYS.includes(p.sub)) { ignored.push(k); continue; }
        out[key] = { ...(typeof out[key] === "object" && out[key] ? out[key] : {}), [p.sub]: v.trim() };
        break;
      }
      case "date": {
        if (p.sub && DATE_KEYS.includes(p.sub)) {
          const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(out[key] || "")) || [null, "", "", ""];
          const d = { year: m[1], month: m[2], day: m[3] };
          d[p.sub] = p.sub === "year" ? v.trim() : v.trim().padStart(2, "0");
          out[key] = d.year && d.month && d.day ? `${d.year}-${d.month}-${d.day}` : out[key];
          // A part-way date (the other parts arrive in the same edit) is completed below.
          out[`__date_${key}`] = d;
        } else if (!p.sub) out[key] = v.trim() ? parseDate(v) : "";
        else { ignored.push(k); continue; }
        break;
      }
      case "phone": {
        if (!p.sub || p.sub === "full") out[key] = v.trim() ? parsePhone(v) : "";
        else if (p.sub === "phone") out[key] = { ...(out[key] || { cc: "" }), number: v.trim() };
        else if (p.sub === "country") out[key] = { ...(out[key] || { number: "" }), cc: v.replace(/\D/g, "") };
        else if (p.sub === "area") { /* folded into the number by the portals */ continue; }
        else { ignored.push(k); continue; }
        break;
      }
      case "checkbox": {
        if (p.sub != null && /^\d+$/.test(p.sub)) {
          const arr = Array.isArray(out[key]) ? [...out[key]] : [];
          arr[Number(p.sub)] = v; out[key] = arr.filter((x) => x != null && x !== "");
        } else if (!p.sub) out[key] = v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        else { ignored.push(k); continue; }
        break;
      }
      case "email": out[key] = v.trim().toLowerCase(); break;
      default:
        if (p.sub) { ignored.push(k); continue; }
        out[key] = v;
    }
    changed.add(key);
  }
  // Finish dates edited part by part.
  for (const k of Object.keys(out)) {
    if (!k.startsWith("__date_")) continue;
    const key = k.slice(7); const d = out[k];
    if (d.year && d.month && d.day) out[key] = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
    delete out[k];
  }
  for (const k of Object.keys(out)) if (out[k] === "" || (Array.isArray(out[k]) && !out[k].length)) delete out[k];
  return { answers: out, changed: [...changed], ignored };
}
