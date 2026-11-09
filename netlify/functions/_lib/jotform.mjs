// Jotform mirror: writes each application into the live Unearthed Jotform form
// (251396787451873, same field IDs), so both Unearthed portals keep reading it
// exactly as before — including leader edits, which write back to that
// submission. Env: JOTFORM_API_KEY (same key the portals use).
// Env: JOTFORM_API_KEY, JOTFORM_BASE_URL (optional, e.g. https://eu-api.jotform.com)

function base() {
  return (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");
}
function key() {
  const k = process.env.JOTFORM_API_KEY;
  if (!k) throw new Error("JOTFORM_API_KEY is not configured");
  return k;
}

async function post(path, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, v == null ? "" : String(v));
  const res = await fetch(`${base()}${path}?apiKey=${encodeURIComponent(key())}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok || (data && data.responseCode && data.responseCode >= 400)) {
    throw new Error(`Jotform ${path} → ${res.status}: ${(data?.message || text || "").slice(0, 300)}`);
  }
  return data;
}

/** Creates a submission; returns its Jotform submission id. */
export async function createSubmission(formId, params) {
  const data = await post(`/form/${encodeURIComponent(formId)}/submissions`, params);
  const id = data?.content?.submissionID || data?.content?.[0]?.submissionID || data?.content?.id;
  if (!id) throw new Error(`Jotform did not return a submission id: ${JSON.stringify(data).slice(0, 200)}`);
  return String(id);
}

export async function updateSubmission(submissionId, params) {
  return post(`/submission/${encodeURIComponent(submissionId)}`, params);
}

async function get(path, params = {}) {
  const qs = new URLSearchParams({ apiKey: key(), ...params });
  const res = await fetch(`${base()}${path}?${qs}`, { headers: { Accept: "application/json" } });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.responseCode && data.responseCode >= 400)) throw new Error(`Jotform ${path} → ${res.status}: ${data?.message || ""}`.slice(0, 300));
  return data?.content;
}

/** Newest submission on any of `formIds` whose email answer is `email` (or null). */
export async function findSubmissionByEmail(formIds, email) {
  const e = String(email || "").trim().toLowerCase();
  for (const formId of formIds) {
    for (let offset = 0; offset < 3000; offset += 500) {
      const subs = await get(`/form/${encodeURIComponent(formId)}/submissions`, { limit: "500", offset: String(offset), orderby: "created_at", direction: "DESC" });
      for (const s of subs || []) {
        if (s.status === "DELETED") continue;
        const hit = Object.values(s.answers || {}).some((a) => a?.type === "control_email" && String(a.answer || "").trim().toLowerCase() === e);
        if (hit) return { ...s, formId };
      }
      if (!subs || subs.length < 500) break;
    }
  }
  return null;
}
