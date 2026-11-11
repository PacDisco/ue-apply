// /api/apply — the public application flow.
//
//   GET  ?trip=<slug>[&kind=teacher]    trip + published form (launch link; /<slug>/teacher = teacher form)
//   GET  ?token=<token>                 resume: trip, form, where they're up to
//   GET  ?sign=<signToken>              parent signing page data
//   POST { action: "start", trip, values, attribution }
//   POST { action: "resume", trip, email }           emails a continue link
//   POST { action: "save", token, values }           draft (no validation)
//   POST { action: "submit", token, values }         full application
//   POST { action: "send-waiver", token, email }     email a parent the signing link
//   POST { action: "sign", token | signToken, input }
//   POST { action: "checkout", token | signToken, method } → { url } (Stripe; only once a parent has signed)
//   POST { action: "confirm", token?, sessionId }    after Stripe redirects back
import * as A from "./_lib/applications.mjs";
import { json, readJson, errorResponse, clientIp } from "./_lib/http.mjs";

export default async (req, context) => {
  try {
    const url = new URL(req.url);
    if (req.method === "GET") {
      if (url.searchParams.get("sign")) return json(await A.signInfo(url.searchParams.get("sign")));
      if (url.searchParams.get("token")) return json(await A.resume(url.searchParams.get("token")));
      if (url.searchParams.get("trip")) return json(await A.launch(url.searchParams.get("trip"), url.searchParams.get("kind")), 200, { "Cache-Control": "public, max-age=30" });
      return json({ error: "Missing trip" }, 400);
    }
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const b = await readJson(req);
    switch (b.action) {
      case "start": return json(await A.start({ slug: b.trip, kind: b.kind, role: b.role, values: b.values, attribution: b.attribution }));
      case "resume": return json(await A.requestResume({ slug: b.trip, kind: b.kind, email: b.email }));
      case "save": return json(await A.saveDraft({ token: b.token, values: b.values }));
      case "submit": return json(await A.submit({ token: b.token, values: b.values }));
      case "send-waiver": return json(await A.sendForSignature({ token: b.token, email: b.email }));
      case "sign": return json(await A.sign({ token: b.token, signToken: b.signToken, input: b.input, ip: clientIp(req, context), userAgent: req.headers.get("user-agent") }));
      case "checkout": return json(await A.checkout({ token: b.token, signToken: b.signToken, method: b.method }));
      case "confirm": return json(await A.confirmDeposit({ token: b.token, sessionId: b.sessionId }));
      default: return json({ error: "Unknown action" }, 400);
    }
  } catch (err) {
    return errorResponse(err, "apply");
  }
};

export const config = { path: "/api/apply" };
