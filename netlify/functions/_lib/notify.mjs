// Emails, sent from the Unearthed mailbox over Google Workspace SMTP (same
// setup as the portals' magic-link emails).
//
// Env:
//   SMTP_USER / SMTP_PASS   mailbox + Google App Password
//   SMTP_FROM_NAME          optional, default "Unearthed Education"
//   UE_APPLY_ALERT_EMAIL    staff alerts (new application, deposit paid);
//                           comma-separate several; "off" disables
//   UE_PORTAL_URL           the student/parent portal, linked after the deposit
//
// Wording can be overridden in the dashboard (Settings → Emails): each email
// has a subject and a message with {{student}}, {{studentFirst}}, {{trip}},
// {{school}}, {{link}}, {{amount}}, {{parent}} placeholders.
import nodemailer from "nodemailer";
import { DEFAULT_EMAILS, defaultEmail } from "../../../public/emails.mjs";

export { DEFAULT_EMAILS };

let _transport = null;
export function __setTransport(t) { _transport = t; }
function transport() {
  if (!_transport) {
    _transport = nodemailer.createTransport({ host: "smtp.gmail.com", port: 587, secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  }
  return _transport;
}
export const mailOn = () => !!_transport || (!!process.env.SMTP_USER && !!process.env.SMTP_PASS);

export function staffRecipients() {
  const raw = String(process.env.UE_APPLY_ALERT_EMAIL || "").trim();
  if (!raw || /^(off|none|false|0)$/i.test(raw)) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function fill(tpl, vars) {
  return String(tpl || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
}

/** Subject, text and HTML for one email kind. Pure (tested). */
export function compose(kind, vars, schema) {
  const o = schema?.settings?.emails?.[kind] || {};
  const d = defaultEmail(kind, schema?.settings?.kind === "teacher" ? "teacher" : "student");
  const subject = fill(o.subject || d.subject, vars);
  const text = fill(o.body || d.body, vars);
  const html = `<div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.55;color:#231f20;max-width:560px">${text.split(/\n{2,}/).map((p) => {
    const linked = esc(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2d6b74">$1</a>').replace(/\n/g, "<br>");
    return `<p style="margin:0 0 14px">${linked}</p>`;
  }).join("")}<p style="margin:24px 0 0;color:#6b6b6b;font-size:13px">Unearthed Education · info@unearthededucation.org · +64 (3) 288 2393</p></div>`;
  return { subject, text, html };
}

export async function send({ to, cc, subject, text, html, attachments, replyTo }) {
  if (!mailOn()) return { skipped: "SMTP not configured" };
  const list = [].concat(to || []).filter(Boolean);
  if (!list.length) return { skipped: "no recipient" };
  const from = `"${process.env.SMTP_FROM_NAME || "Unearthed Education"}" <${process.env.SMTP_USER || "no-reply@unearthededucation.org"}>`;
  const info = await transport().sendMail({ from, to: list.join(", "), ...(cc?.length ? { cc: cc.join(", ") } : {}), ...(replyTo ? { replyTo } : {}), subject, text, html, attachments });
  return { messageId: info?.messageId || null };
}

export async function sendKind(kind, { to, cc, vars, schema, attachments }) {
  const m = compose(kind, vars, schema);
  return send({ to, cc, ...m, attachments });
}

export async function alertStaff(subject, lines) {
  const to = staffRecipients();
  if (!to.length) return { skipped: "no staff recipients" };
  const text = lines.filter(Boolean).join("\n");
  return send({ to, subject, text, html: `<div style="font-family:Arial,sans-serif;font-size:14px">${lines.filter(Boolean).map((l) => `<p style="margin:0 0 8px">${esc(l).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`).join("")}</div>` });
}
