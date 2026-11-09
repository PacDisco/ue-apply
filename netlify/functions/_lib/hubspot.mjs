// The HubSpot calls ue-apply needs. Token: HUBSPOT_TOKEN (private app).
// Scopes: crm.objects.contacts.read/write, crm.objects.deals.read/write,
// crm.objects.custom.read/write (Unearthed Program records + associations),
// crm.schemas.deals.read (pipelines), files (the signed waiver PDF).

const API = "https://api.hubapi.com";

let _fetch = (...a) => fetch(...a);
/** Tests swap in a fake HubSpot. */
export function __setFetch(f) { _fetch = f; _labels.clear(); _stages.clear(); }

export async function hs(path, { method = "GET", body } = {}) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN is not set");
  for (let attempt = 0; attempt < 3; attempt++) {
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const res = await _fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body && !isForm ? { "Content-Type": "application/json" } : {}) },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
    if (res.status === 429 && attempt < 2) { await new Promise((r) => setTimeout(r, 1100 * (attempt + 1))); continue; }
    if (res.status === 204) return {};
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) return null;
    if (!res.ok) {
      const e = new Error(`HubSpot ${res.status} on ${method} ${path.split("?")[0]}: ${data?.message || "request failed"}`);
      e.status = res.status; e.data = data;
      throw e;
    }
    return data;
  }
}

// ── contacts ────────────────────────────────────────────────────────────────

export async function findContactByEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e.includes("@")) return null;
  const data = await hs(`/crm/v3/objects/contacts/search`, {
    method: "POST",
    body: {
      filterGroups: [
        { filters: [{ propertyName: "email", operator: "EQ", value: e }] },
        { filters: [{ propertyName: "hs_additional_emails", operator: "CONTAINS_TOKEN", value: e }] },
      ],
      properties: ["email", "firstname", "lastname", "company_tag"],
      sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
      limit: 5,
    },
  });
  const r = data?.results?.[0];
  return r ? { id: String(r.id), properties: r.properties || {} } : null;
}

/**
 * Create the contact, or update the one with that email. Blank values are
 * never written (so we don't wipe what HubSpot already holds). `ifEmpty`
 * properties are only set when the contact doesn't have them yet.
 */
export async function upsertContact(email, props = {}, { ifEmpty = {} } = {}) {
  const e = String(email || "").trim().toLowerCase();
  const clean = Object.fromEntries(Object.entries(props).filter(([, v]) => v != null && String(v).trim() !== ""));
  const existing = await findContactByEmail(e);
  if (existing) {
    const extra = Object.fromEntries(Object.entries(ifEmpty).filter(([k, v]) => v != null && v !== "" && !String(existing.properties?.[k] || "").trim()));
    const update = { ...clean, ...extra };
    delete update.email;
    if (Object.keys(update).length) await hs(`/crm/v3/objects/contacts/${existing.id}`, { method: "PATCH", body: { properties: update } });
    return { id: existing.id, created: false };
  }
  try {
    const data = await hs(`/crm/v3/objects/contacts`, { method: "POST", body: { properties: { ...ifEmpty, ...clean, email: e } } });
    return { id: String(data.id), created: true };
  } catch (err) {
    if (err.status === 409) { // created by someone else in the meantime
      const again = await findContactByEmail(e);
      if (again) return { id: again.id, created: false };
    }
    throw err;
  }
}

// ── deals ───────────────────────────────────────────────────────────────────

export async function getDeal(id, properties = ["dealname", "pipeline", "dealstage", "amount"]) {
  if (!/^\d+$/.test(String(id || ""))) return null;
  return hs(`/crm/v3/objects/deals/${id}?properties=${properties.join(",")}`);
}

export async function createDeal(properties) {
  const data = await hs(`/crm/v3/objects/deals`, { method: "POST", body: { properties } });
  return String(data.id);
}

export async function updateDeal(id, properties) {
  return hs(`/crm/v3/objects/deals/${id}`, { method: "PATCH", body: { properties } });
}

/** Open deals of a contact in one pipeline (newest first). */
export async function contactDealsInPipeline(contactId, pipelineId) {
  const assoc = await hs(`/crm/v4/objects/contacts/${contactId}/associations/deals?limit=100`);
  const ids = (assoc?.results || []).map((r) => String(r.toObjectId));
  if (!ids.length) return [];
  const data = await hs(`/crm/v3/objects/deals/batch/read`, {
    method: "POST",
    body: { inputs: ids.map((id) => ({ id })), properties: ["dealname", "pipeline", "dealstage", "amount", "createdate", "hs_is_closed_lost"] },
  });
  return (data?.results || [])
    .filter((d) => String(d.properties?.pipeline) === String(pipelineId) && d.properties?.hs_is_closed_lost !== "true")
    .sort((a, b) => String(b.properties?.createdate || "").localeCompare(String(a.properties?.createdate || "")));
}

const _stages = new Map();
/** Stage id in a pipeline whose label matches `re` (e.g. /application\s*complete/i). */
export async function stageId(pipelineId, re) {
  if (!_stages.has(pipelineId)) {
    const p = await hs(`/crm/v3/pipelines/deals/${encodeURIComponent(pipelineId)}`);
    _stages.set(pipelineId, (p?.stages || []).slice().sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)));
  }
  const stages = _stages.get(pipelineId);
  return (stages.find((s) => re.test(s.label || "")) || stages[0] || null)?.id || null;
}

// ── associations ────────────────────────────────────────────────────────────

const TYPE = { contacts: "contacts", contact: "contacts", deals: "deals", deal: "deals" };
const _labels = new Map();

async function labelType(from, to, label) {
  const k = `${from}|${to}`;
  if (!_labels.has(k)) {
    const data = await hs(`/crm/v4/associations/${from}/${to}/labels`);
    _labels.set(k, data?.results || []);
  }
  const want = String(label || "").trim().toLowerCase();
  return _labels.get(k).find((l) => String(l.label || "").trim().toLowerCase() === want) || null;
}

/**
 * Associate two records, with a label when one is given and exists (e.g.
 * "Student", "Parent"); otherwise the default (unlabeled) association.
 * Re-running is harmless — HubSpot keeps one association per pair.
 */
export async function associate(fromType, fromId, toType, toId, label = null) {
  const from = TYPE[fromType] || fromType;
  const to = TYPE[toType] || toType;
  if (label) {
    const t = await labelType(from, to, label);
    if (t) {
      await hs(`/crm/v4/objects/${from}/${fromId}/associations/${to}/${toId}`, {
        method: "PUT",
        body: [{ associationCategory: t.category || "USER_DEFINED", associationTypeId: Number(t.typeId) }],
      });
      return { label: t.label };
    }
  }
  await hs(`/crm/v4/objects/${from}/${fromId}/associations/default/${to}/${toId}`, { method: "PUT" });
  return { label: null };
}

// ── custom object: Unearthed Program ────────────────────────────────────────

export async function getObject(objectType, id, properties) {
  if (!/^\d+$/.test(String(id || ""))) return null;
  return hs(`/crm/v3/objects/${objectType}/${id}?properties=${properties.join(",")}`);
}

// ── files + notes (signed waiver) ───────────────────────────────────────────

export async function uploadFile(bytes, fileName, folderPath = "/Unearthed Permissions") {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/pdf" }), fileName);
  form.append("fileName", fileName);
  form.append("folderPath", folderPath);
  form.append("options", JSON.stringify({ access: "PRIVATE", overwrite: false, duplicateValidationStrategy: "NONE" }));
  const data = await hs(`/files/v3/files`, { method: "POST", body: form });
  if (!data?.id) throw new Error("HubSpot file upload returned no id");
  return String(data.id);
}

// HUBSPOT_DEFINED association types: note → contact 202, note → deal 214.
export async function createNote({ body, fileId, contactIds = [], dealId, timestamp }) {
  const associations = [];
  for (const id of [...new Set(contactIds.filter(Boolean).map(String))]) associations.push({ to: { id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] });
  if (dealId) associations.push({ to: { id: String(dealId) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }] });
  const data = await hs(`/crm/v3/objects/notes`, {
    method: "POST",
    body: { properties: { hs_timestamp: timestamp || new Date().toISOString(), hs_note_body: body, ...(fileId ? { hs_attachment_ids: String(fileId) } : {}) }, associations },
  });
  return String(data?.id || "");
}
