// The signed permissions packet as a PDF — attached to the student's HubSpot
// contact and deal, and emailed to the parent who signed.
import { jsPDF } from "jspdf";
import { htmlBlocks, partsFor } from "../../../public/waiver-kit.mjs";

// Standard PDF fonts only cover Latin-1; keep the text printable.
export function pdfText(s) {
  return String(s ?? "")
    .replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-").replace(/…/g, "...").replace(/ /g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ]/g, "?");
}

/**
 * @param {{ waiver, under18, student: { name, dob }, trip: { name }, signed: { parentName, relationship, initials, signature, signedAt, ip } }} o
 * @returns Uint8Array
 */
export function waiverPdf({ waiver, under18, student, trip, signed, role = "Student" }) {
  const self = signed?.relationship === "Self";
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 48;
  let y = M;
  const need = (h) => { if (y + h > H - M) { doc.addPage(); y = M; } };
  const write = (text, { size = 10, bold = false, indent = 0, gap = 6, color = 20 } = {}) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(color);
    const lines = doc.splitTextToSize(pdfText(text), W - M * 2 - indent);
    for (const line of lines) { need(size * 1.35); doc.text(line, M + indent, y); y += size * 1.35; }
    y += gap;
  };

  write(waiver.title || "Permissions packet", { size: 16, bold: true, gap: 4 });
  write(`${role}: ${student.name}${student.dob ? `  (date of birth ${student.dob})` : ""}`, { size: 10, gap: 2 });
  write(`Program: ${trip.name || ""}`, { size: 10, gap: 12 });
  for (const b of htmlBlocks(waiver.intro || "")) write(b.kind === "li" ? `• ${b.text}` : b.text, { bold: b.kind === "h", indent: b.kind === "li" ? 12 * b.depth : 0 });

  for (const part of partsFor(waiver, { under18 })) {
    y += 6;
    write(part.title, { size: 12, bold: true });
    for (const b of htmlBlocks(part.html)) write(b.kind === "li" ? `• ${b.text}` : b.text, { bold: b.kind === "h", indent: b.kind === "li" ? 12 * b.depth : 0, gap: 4 });
    write(`Initialled by ${self ? "the signer" : "the parent/guardian"}: ${signed.initials?.[part.key] || "-"}`, { bold: true, gap: 10 });
  }

  y += 8;
  write(waiver.declaration || "", { bold: true, gap: 10 });
  write(`Signed by: ${signed.parentName} (${self ? "signed for themselves" : signed.relationship})`, { gap: 2 });
  write(`Date: ${new Date(signed.signedAt).toLocaleString("en-NZ", { timeZone: "Pacific/Auckland", dateStyle: "long", timeStyle: "short" })} (NZ time)`, { gap: 2 });
  if (signed.ip) write(`Signed online at apply.unearthededucation.org from IP ${signed.ip}`, { size: 8, color: 110, gap: 8 });
  need(110);
  try { doc.addImage(signed.signature, "PNG", M, y, 240, 90); } catch { write("[signature image could not be embedded]"); }
  y += 96;
  doc.setDrawColor(150); doc.line(M, y, M + 240, y);
  y += 12;
  write("Signature", { size: 8, color: 110 });
  return new Uint8Array(doc.output("arraybuffer"));
}
