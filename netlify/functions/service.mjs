// /api/service — for the pd-dashboard (Unearthed Application Form) only.
// Header x-apply-key = APPLY_SERVICE_KEY (same secret on both sites).
//
//   POST { action: "resync", id, only? }        re-run HubSpot / Jotform for one application
//   POST { action: "lookup", email }            Add from HubSpot: what exists for this email
//   POST { action: "import", email, slug, dealId?, actor }
//   POST { action: "send-waiver", id, email? }  (re)send the parent signing link
//   POST { action: "withdraw", id, actor }
//   POST { action: "waiver-pdf", id }           → application/pdf
//   POST { action: "approve-teacher", id, actor, role? } Teacher / Trip Leader label on the trip (→ leader portal)
import * as W from "../../public/waiver-kit.mjs";
import { q, appById, publishedSchema } from "./_lib/db.mjs";
import { json, readJson, serviceOk, errorResponse, bad, newToken, hashToken, siteUrl } from "./_lib/http.mjs";
import { tripBySlug, __clearTripCache } from "./_lib/trips.mjs";
import * as Sync from "./_lib/sync.mjs";
import * as Imp from "./_lib/import.mjs";
import * as N from "./_lib/notify.mjs";
import { waiverPdf } from "./_lib/pdf.mjs";
import { isUnder18 } from "./_lib/applications.mjs";

export default async (req) => {
  if (!serviceOk(req)) return json({ error: "Not allowed" }, 403);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const b = await readJson(req);
    // The form that goes with the application (student or teacher).
    const target = b.id ? await appById(b.id) : null;
    const { schema } = await publishedSchema({ fresh: true, kind: target?.kind }).catch((e) => { if (target?.kind === "teacher") throw e; return publishedSchema({ fresh: true }); });
    switch (b.action) {
      case "approve-teacher": {
        const app = await need(b.id);
        const row = await Sync.approveTeacher(app, { actor: b.actor, schema, role: b.role });
        return json({ app: row });
      }
      case "resync": {
        const app = await need(b.id);
        __clearTripCache();
        const trip = await tripBySlug(app.trip_slug, { fresh: true });
        const only = Array.isArray(b.only) && b.only.length ? b.only : null;
        const result = await Sync.syncApplication(app, { schema, trip, only });
        return json({ result, app: await appById(app.id) });
      }
      case "lookup": return json(await Imp.lookup(b.email));
      case "import": return json({ app: await Imp.importApplicant({ email: b.email, slug: b.slug, dealId: b.dealId, actor: b.actor, schema }) });
      case "send-waiver": {
        const app = await need(b.id);
        if (app.kind === "teacher") throw bad("Teachers sign their own waiver from their application link.", 400);
        if (app.waiver?.status === "signed") throw bad("Already signed.", 409);
        const to = String(b.email || app.waiver?.sentTo || app.answers?.parent1Email || "").trim().toLowerCase();
        if (!to.includes("@")) throw bad("No parent email to send to.");
        const trip = await tripBySlug(app.trip_slug);
        const signToken = newToken();
        const waiver = { ...(app.waiver || {}), status: "sent", sentTo: to, sentAt: new Date().toISOString(), signTokenHash: hashToken(signToken), sentBy: b.actor || null };
        await q(`UPDATE ue_applications SET waiver = $2, updated_at = now() WHERE id = $1`, [app.id, JSON.stringify(waiver)]);
        const name = app.answers?.name || {};
        const r = await N.sendKind("signRequest", { to: [to], schema, vars: { parent: "there", student: [name.first, name.last].filter(Boolean).join(" ") || app.email, studentFirst: name.first || "", trip: trip?.name || app.program_name, link: `${siteUrl()}/sign?t=${encodeURIComponent(signToken)}` } });
        return json({ ok: true, emailed: !r.skipped, to });
      }
      case "withdraw": {
        const rows = await q(`UPDATE ue_applications SET status = 'withdrawn', token_hash = NULL, sync = sync || jsonb_build_object('withdrawn', jsonb_build_object('at', now(), 'by', $2::text)), updated_at = now() WHERE id = $1 RETURNING id`, [b.id, String(b.actor || "")]);
        if (!rows[0]) throw bad("Not found", 404);
        return json({ ok: true });
      }
      case "waiver-pdf": {
        const app = await need(b.id);
        if (app.waiver?.status !== "signed") throw bad("Not signed yet.", 404);
        const trip = (await tripBySlug(app.trip_slug)) || { name: app.program_name };
        const name = app.answers?.name || {};
        const bytes = waiverPdf({ waiver: app.waiver.text?.parts ? app.waiver.text : W.waiverOf(schema), under18: app.waiver.under18 ?? isUnder18(app), student: { name: [name.first, name.last].filter(Boolean).join(" ") || app.email, dob: app.answers?.dob }, trip, signed: { ...app.waiver, signature: app.waiver_signature }, role: app.kind === "teacher" ? "Teacher" : "Student" });
        return new Response(bytes, { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" } });
      }
      default: return json({ error: "Unknown action" }, 400);
    }
  } catch (err) {
    return errorResponse(err, "service");
  }
};

async function need(id) {
  const app = await appById(id);
  if (!app) throw bad("Application not found.", 404);
  return app;
}

export const config = { path: "/api/service" };
