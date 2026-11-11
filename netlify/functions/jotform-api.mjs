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
  // Streamed, so a big page (1000 submissions) isn't held to the buffered-response size limit.
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const CHUNK = 256 * 1024;
  let i = 0;
  const stream = new ReadableStream({
    pull(c) { if (i >= bytes.length) { c.close(); return; } c.enqueue(bytes.subarray(i, i + CHUNK)); i += CHUNK; },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
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
  return new Response(res.body, { status: res.status, headers: { "Content-Type": res.headers.get?.("content-type") || "application/json", "Cache-Control": "no-store" } });
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
  return { app, sub: G.toSubmission(app, schema, { tripRow, fileUrl }) };
}

async function findServed(id) {
  if (!/^\d{1,25}$/.test(String(id))) return null;
  const [app] = await servedApps(`AND (a.submission_id = $1 OR a.jotform_submission_id = $1)`, [String(id)]);
  return app || null;
}

async function listSubmissions(formId, url) {
  const { schema } = await publishedSchema();
  if (String(formId) !== G.appFormId(schema)) return null; // not ours → Jotform
  const ours = (await servedApps()).map((a) => shape(a, schema));
  const offset = Number(url.searchParams.get("offset")) || 0;
  const limit = Number(url.searchParams.get("limit")) || 20;
  if (!flag("JOTFORM_FALLBACK", true)) {
    const own = G.ownPage(ours, { offset, limit });
    return jfJson(G.envelope(own.content, { resultSet: own.resultSet }));
  }
  const data = await upstreamJson(`/form/${encodeURIComponent(formId)}/submissions`, url);
  const content = G.mergePage(data.content, ours, { offset });
  return jfJson({ ...data, content, resultSet: { ...(data.resultSet || {}), count: content.length } });
}

async function getSubmission(id) {
  const app = await findServed(id);
  if (!app) return null;
  const { schema } = await publishedSchema();
  return jfJson(G.envelope(shape(app, schema).sub));
}

async function editSubmission(req, id) {
  const app = await findServed(id);
  if (!app) return null;
  const { schema } = await publishedSchema();
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

export default async (req) => {
  const url = new URL(req.url);
  if (!authorised(req)) return jfError("You're not authorized to use this resource.", 401);
  const path = url.pathname.slice(url.pathname.indexOf(PREFIX) + PREFIX.length) || "/";
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
