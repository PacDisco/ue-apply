// /api/jotform/* — the Unearthed portals' application data source.
// A Jotform-compatible API: set the portals' JOTFORM_BASE_URL to
// https://apply.unearthededucation.org/api/jotform and they read (and leader
// edits save) applications made on this site from this site's database.
// Anything else goes through to Jotform while JOTFORM_FALLBACK is on (default).
// See _lib/jf-gateway.mjs.
//
// Auth: the caller's Jotform API key (`apiKey` query or APIKEY header) must be
// this site's JOTFORM_API_KEY or APPLY_SERVICE_KEY — the same key the portals
// already send to Jotform.
import * as G from "./_lib/jf-gateway.mjs";
import * as K from "../../public/form-kit.mjs";
import { q, publishedSchema, noteSync } from "./_lib/db.mjs";
import { fileUrl, flag, safeEqual } from "./_lib/http.mjs";

const PREFIX = "/api/jotform";

/** Real Jotform. Never this API itself (a JOTFORM_BASE_URL copied from a portal would loop). */
function upstreamBase() {
  for (const v of [process.env.JOTFORM_UPSTREAM_URL, process.env.JOTFORM_BASE_URL]) {
    const b = String(v || "").trim().replace(/\/+$/, "");
    if (b && !b.includes(PREFIX)) return b;
  }
  return "https://api.jotform.com";
}

function jfError(message, status) {
  return new Response(JSON.stringify({ responseCode: status, message, content: "", duration: "0ms" }), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
function jfJson(body) {
  return sendBytes(new TextEncoder().encode(JSON.stringify(body)), 200, "application/json");
}
function sendBytes(bytes, status, type) {
  // Streamed, so a big page (1000 submissions) isn't held to the buffered-response size limit.
  const CHUNK = 256 * 1024;
  let i = 0;
  const stream = new ReadableStream({
    pull(c) { if (i >= bytes.length) { c.close(); return; } c.enqueue(bytes.subarray(i, i + CHUNK)); i += CHUNK; },
  });
  return new Response(stream, { status, headers: { "Content-Type": type, "Cache-Control": "no-store" } });
}

export function authorised(req) {
  const u = new URL(req.url);
  const given = u.searchParams.get("apiKey") || req.headers.get("apikey") || "";
  return [process.env.JOTFORM_API_KEY, process.env.APPLY_SERVICE_KEY].some((k) => k && safeEqual(given, k));
}

/** Pass a request through to Jotform with this site's key. */
async function proxy(req, path, url) {
  if (!flag("JOTFORM_FALLBACK", true)) return null;
  const key = process.env.JOTFORM_API_KEY;
  if (!key) return jfError("JOTFORM_API_KEY is not configured on the apply site.", 500);
  const base = upstreamBase();
  const qs = new URLSearchParams(url.searchParams);
  qs.set("apiKey", key);
  const init = { method: req.method, headers: { Accept: "application/json" } };
  if (!["GET", "HEAD"].includes(req.method)) {
    init.body = await req.text();
    init.headers["Content-Type"] = req.headers.get("content-type") || "application/x-www-form-urlencoded";
  }
  const res = await fetch(`${base}${path}?${qs}`, init);
  // Read it all, then send — handing Jotform's (compressed, chunked) stream
  // straight back isn't reliable through Netlify.
  const bytes = new Uint8Array(await res.arrayBuffer());
  console.log(`[jotform-api] ${req.method} ${path} → Jotform ${res.status}, ${bytes.length} bytes`);
  return sendBytes(bytes, res.status, res.headers.get?.("content-type") || "application/json");
}

async function upstreamJson(path, url) {
  const key = process.env.JOTFORM_API_KEY;
  const qs = new URLSearchParams(url.searchParams);
  qs.set("apiKey", key || "");
  const res = await fetch(`${upstreamBase()}${path}?${qs}`, { headers: { Accept: "application/json" } });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw Object.assign(new Error(`Jotform ${res.status}: ${data?.message || ""}`.slice(0, 300)), { status: res.status || 502 });
  return data;
}

// ── our applications ────────────────────────────────────────────────────────

async function servedApps(where = "", params = []) {
  return q(`SELECT a.*, t.slug AS t_slug, t.program_id AS t_program_id, t.program_name AS t_program_name, t.school AS t_school,
                   t.destination AS t_destination, t.currency AS t_currency, t.open AS t_open
              FROM ue_applications a LEFT JOIN ue_apply_trips t ON t.slug = a.trip_slug
             WHERE ${G.SERVED_SQL} ${where}
             ORDER BY coalesce(a.step2_at, a.created_at) DESC`, params);
}

function shape(app, schema) {
  const tripRow = app.t_slug ? { slug: app.t_slug, program_id: app.t_program_id, program_name: app.t_program_name, school: app.t_school, destination: app.t_destination, currency: app.t_currency, open: app.t_open } : null;
  const formId = app.kind === "teacher" ? K.TEACHER_FORM_ID : G.appFormId(schema);
  return { app, sub: G.toSubmission(app, schema, { tripRow, fileUrl, formId }) };
}

/** The published form that goes with an application (student or teacher). */
const schemaFor = async (app) => (await publishedSchema({ kind: app?.kind })).schema;

async function findServed(id) {
  if (!/^\d{1,25}$/.test(String(id))) return null;
  const [app] = await servedApps(`AND (a.submission_id = $1 OR a.jotform_submission_id = $1)`, [String(id)]);
  return app || null;
}

/** Teacher applications: only ever from here (they have no Jotform form). */
async function listTeachers(url) {
  const { schema } = await publishedSchema({ kind: "teacher" });
  const ours = (await servedApps(`AND a.kind = 'teacher'`)).map((a) => shape(a, schema));
  const own = G.ownPage(ours, { offset: Number(url.searchParams.get("offset")) || 0, limit: Number(url.searchParams.get("limit")) || 20 });
  return jfJson(G.envelope(own.content, { resultSet: own.resultSet }));
}

/**
 * Our applications for the list, or [] if anything about them fails (form not
 * published yet, migration not run, database down). Jotform's data must never
 * be lost because of ours — the portals would show nothing.
 */
async function oursSafely() {
  try {
    const { schema } = await publishedSchema();
    return { schema, ours: (await servedApps(`AND a.kind = 'student'`)).map((a) => shape(a, schema)) };
  } catch (err) {
    console.error("[jotform-api] serving Jotform only:", err?.message || err);
    return { schema: null, ours: [], error: err };
  }
}

/** The application form's ID without needing the published schema. */
async function appFormIdSafely() {
  try { return G.appFormId((await publishedSchema()).schema); } catch { return G.appFormId(null); }
}

async function listSubmissions(formId, url) {
  if (String(formId) === K.TEACHER_FORM_ID) return listTeachers(url);
  if (String(formId) !== await appFormIdSafely()) return null; // not ours → Jotform as-is
  const offset = Number(url.searchParams.get("offset")) || 0;
  const limit = Number(url.searchParams.get("limit")) || 20;
  if (!flag("JOTFORM_FALLBACK", true)) {
    const { ours, error } = await oursSafely();
    if (error) throw error;
    const own = G.ownPage(ours, { offset, limit });
    return jfJson(G.envelope(own.content, { resultSet: own.resultSet }));
  }
  const [data, { ours }] = await Promise.all([upstreamJson(`/form/${encodeURIComponent(formId)}/submissions`, url), oursSafely()]);
  const content = G.mergePage(data.content, ours, { offset });
  console.log(`[jotform-api] list ${formId} offset ${offset}: ${Array.isArray(data.content) ? data.content.length : 0} from Jotform, ${ours.length} here`);
  return jfJson({ ...data, content, resultSet: { ...(data.resultSet || {}), count: content.length } });
}

async function getSubmission(id) {
  let app = null; let schema = null;
  try {
    app = await findServed(id);
    if (app) schema = await schemaFor(app);
  } catch (err) {
    console.error("[jotform-api] submission from Jotform:", err?.message || err);
    return null; // → Jotform
  }
  if (!app) return null;
  return jfJson(G.envelope(shape(app, schema).sub));
}

async function editSubmission(req, id) {
  let app = null;
  try { app = await findServed(id); } catch (err) { console.error("[jotform-api] edit to Jotform:", err?.message || err); return null; }
  if (!app) return null;
  const schema = await schemaFor(app);
  const raw = await req.text();
  const pairs = [...new URLSearchParams(raw).entries()];
  const r = G.applyEdit(schema, app.answers, pairs);
  if (r.changed.length) {
    const name = r.answers.name && typeof r.answers.name === "object" ? r.answers.name : null;
    await q(`UPDATE ue_applications
                SET answers = $2, updated_at = now(),
                    email = coalesce(nullif($3, ''), email),
                    first_name = coalesce(nullif($4, ''), first_name), last_name = coalesce(nullif($5, ''), last_name)
              WHERE id = $1`,
      [app.id, JSON.stringify(r.answers), r.changed.includes("email") ? r.answers.email || "" : "",
        name && r.changed.includes("name") ? name.first || "" : "", name && r.changed.includes("name") ? name.last || "" : ""]);
  }
  // While Jotform still keeps a copy, keep it in step (best effort — ours is saved).
  if (app.jotform_submission_id && flag("JOTFORM_MIRROR", true) && process.env.JOTFORM_API_KEY) {
    try {
      const res = await fetch(`${upstreamBase()}/submission/${encodeURIComponent(app.jotform_submission_id)}?apiKey=${encodeURIComponent(process.env.JOTFORM_API_KEY)}`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: raw,
      });
      if (!res.ok) throw new Error(`Jotform ${res.status}`);
    } catch (err) {
      await noteSync(app.id, "jotform", { ok: false, error: `Portal edit not copied to Jotform: ${err.message}` }).catch(() => {});
    }
  }
  return jfJson(G.envelope({ submissionID: String(app.submission_id), changed: r.changed, ignored: r.ignored }));
}

/** GET /api/jotform/health — what's set up, as yes/no only (no data). Add ?apiKey=… to check a portal's key. */
async function health(url) {
  const out = { jotformKeySet: !!process.env.JOTFORM_API_KEY, serviceKeySet: !!process.env.APPLY_SERVICE_KEY };
  const given = url.searchParams.get("apiKey");
  if (given) out.apiKeyAccepted = [process.env.JOTFORM_API_KEY, process.env.APPLY_SERVICE_KEY].some((k) => k && safeEqual(given, k));
  try { await q(`SELECT 1`); out.database = true; } catch (e) { out.database = false; out.databaseError = String(e.message).slice(0, 120); }
  try { await q(`SELECT submission_id FROM ue_applications LIMIT 1`); out.migrationRun = true; } catch { out.migrationRun = false; }
  try { const { rev } = await publishedSchema({ fresh: true }); out.formPublished = true; out.formRev = rev; } catch { out.formPublished = false; }
  try {
    const r = await fetch(`${upstreamBase()}/user?apiKey=${encodeURIComponent(process.env.JOTFORM_API_KEY || "")}`, { headers: { Accept: "application/json" } });
    out.jotformReachable = r.ok; if (!r.ok) out.jotformStatus = r.status;
  } catch { out.jotformReachable = false; }
  out.jotformFallback = flag("JOTFORM_FALLBACK", true); out.jotformMirror = flag("JOTFORM_MIRROR", true);
  out.ok = out.jotformKeySet && out.jotformReachable !== false && (out.apiKeyAccepted !== false);
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.slice(url.pathname.indexOf(PREFIX) + PREFIX.length) || "/";
  if (req.method === "GET" && /^\/health\/?$/.test(path)) return health(url);
  if (!authorised(req)) return jfError("You're not authorized to use this resource.", 401);
  try {
    let m; let res = null;
    if (req.method === "GET" && (m = /^\/form\/(\d+)\/submissions\/?$/.exec(path))) res = await listSubmissions(m[1], url);
    else if (req.method === "GET" && (m = /^\/submission\/(\d+)\/?$/.exec(path))) res = await getSubmission(m[1]);
    else if (req.method === "POST" && (m = /^\/submission\/(\d+)\/?$/.exec(path))) res = await editSubmission(req, m[1]);
    if (res) return res;
    const passed = await proxy(req, path, url);
    if (passed) return passed;
    // Jotform is switched off: an empty list for other forms, 404 for anything else.
    if (req.method === "GET" && /^\/form\/\d+\/submissions\/?$/.test(path)) return jfJson(G.envelope([], { resultSet: { offset: 0, limit: 0, count: 0 } }));
    return jfError("Not found.", 404);
  } catch (err) {
    console.error("[jotform-api]", err);
    return jfError(err.status && err.status < 500 ? err.message : "Application data is unavailable right now.", err.status && err.status < 600 ? err.status : 500);
  }
};

export const config = { path: ["/api/jotform", "/api/jotform/*"] };
