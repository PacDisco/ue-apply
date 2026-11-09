// /api/file/<id> — an uploaded file, for the Unearthed portals (passport
// checks, the photo on leader cards), the dashboard and Jotform's stored link.
// Service key only (x-apply-key) — the applicant never needs to fetch it back.
import { q } from "./_lib/db.mjs";
import { store } from "./_lib/blobs.mjs";
import { json, serviceOk } from "./_lib/http.mjs";

export default async (req, context) => {
  if (!serviceOk(req)) return json({ error: "Not allowed" }, 403);
  const id = context.params?.id || new URL(req.url).pathname.split("/").pop();
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return json({ error: "Not found" }, 404);
  const [f] = await q(`SELECT * FROM ue_apply_files WHERE id = $1`, [id]);
  if (!f) return json({ error: "Not found" }, 404);
  const data = await store().get(f.blob_key, { type: "arrayBuffer" });
  if (!data) return json({ error: "Not found" }, 404);
  const name = String(f.name || "file").replace(/[^\w.\- ]+/g, "_");
  return new Response(data, {
    headers: {
      "Content-Type": f.type || "application/octet-stream",
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
};

export const config = { path: "/api/file/:id" };
