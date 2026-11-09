// Uploaded files (passport, photo …) live in Netlify Blobs on this site.
import { getStore } from "@netlify/blobs";

let _store = null;
export function __setStore(s) { _store = s; }
export function store() {
  if (!_store) _store = getStore({ name: "ue-apply-uploads", consistency: "strong" });
  return _store;
}
