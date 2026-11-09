// /api/upload — one file for one upload field (multipart: token, field, file).
// Images and PDFs only, up to the field's limit (default 10 MB, max 15 MB).
import { randomUUID } from "node:crypto";
import * as A from "./_lib/applications.mjs";
import { store } from "./_lib/blobs.mjs";
import { json, errorResponse, bad } from "./_lib/http.mjs";

export default async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const form = await req.formData();
    const token = String(form.get("token") || "");
    const fieldKey = String(form.get("field") || "");
    const file = form.get("file");
    if (!file || typeof file === "string") throw bad("No file received.");
    const { field } = await A.uploadAllowed(token, fieldKey);
    const max = Math.min(Number(field.maxMb || 10), 15) * 1024 * 1024;
    if (file.size > max) throw bad(`That file is larger than ${Math.round(max / 1048576)} MB.`, 413);
    const type = String(file.type || "").toLowerCase();
    if (!A.UPLOAD_TYPES.test(type)) throw bad("Please upload a photo (JPG, PNG, HEIC) or a PDF.", 415);
    const key = `${randomUUID()}`;
    await store().set(key, await file.arrayBuffer(), { metadata: { type, name: String(file.name || "upload").slice(0, 200) } });
    const rec = await A.recordUpload({ token, fieldKey, name: file.name || "upload", type, size: file.size, blobKey: key });
    return json(rec);
  } catch (err) {
    return errorResponse(err, "upload");
  }
};

export const config = { path: "/api/upload" };
