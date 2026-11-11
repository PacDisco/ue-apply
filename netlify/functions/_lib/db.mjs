// Neon connection. ue-apply shares the pd-dashboard database (the Unearthed
// Application Form editor writes the schema and trip links there; this site
// writes applications there), so the URL is the dashboard site's
// NETLIFY_DATABASE_URL, set here as APPLY_DATABASE_URL.
import { neon } from "@neondatabase/serverless";

let _sql;
/** Tests inject a node-postgres backed stand-in with the same interface. */
export function __setSql(fn) { _sql = fn; }
export function db() {
  if (!_sql) {
    const url = process.env.APPLY_DATABASE_URL || process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) throw new Error("APPLY_DATABASE_URL is not configured");
    _sql = neon(url);
  }
  return _sql;
}
export const q = (text, params = []) => db().query(text, params);

export const FORM_ID = "ue-application";
/** The forms, by applicant kind (rows in ue_apply_forms). */
export const FORM_IDS = { student: "ue-application", teacher: "ue-teacher-application" };
export const KINDS = Object.keys(FORM_IDS);
export const kindOf = (k) => (k === "teacher" ? "teacher" : "student");

const _schemaCache = new Map();
const SCHEMA_TTL_MS = 30 * 1000;
export function __clearSchemaCache() { _schemaCache.clear(); }

/** The PUBLISHED form schema (with its rev) for `kind`, cached briefly per warm container. */
export async function publishedSchema({ fresh = false, kind = "student" } = {}) {
  const k = kindOf(kind);
  const hit = _schemaCache.get(k);
  if (!fresh && hit && Date.now() - hit.at < SCHEMA_TTL_MS) return hit;
  const [row] = await q(`SELECT published, published_rev FROM ue_apply_forms WHERE id = $1`, [FORM_IDS[k]]);
  if (!row || !row.published) throw Object.assign(new Error(k === "teacher" ? "The teacher application form hasn't been published yet." : "The application form hasn't been published yet."), { status: 503 });
  const out = { at: Date.now(), schema: row.published, rev: row.published_rev };
  _schemaCache.set(k, out);
  return out;
}

export async function appById(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return null;
  const [row] = await q(`SELECT * FROM ue_applications WHERE id = $1`, [id]);
  return row || null;
}

export async function appByToken(tokenHash) {
  const [row] = await q(`SELECT * FROM ue_applications WHERE token_hash = $1`, [tokenHash]);
  return row || null;
}

/** Merge into the JSONB `sync` column: { [target]: { ok, at, error?, ... } }. */
export async function noteSync(id, target, value) {
  await q(`UPDATE ue_applications SET sync = coalesce(sync, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb), updated_at = now() WHERE id = $1`,
    [id, target, JSON.stringify({ ...value, at: new Date().toISOString() })]);
}
