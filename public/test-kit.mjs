// Testing the application without typing it all in.
//
//   ?preview=1  Preview mode — click through every step, jump to any step,
//               "Fill test answers" on each page. NOTHING is saved or sent:
//               no application, HubSpot, Jotform, email or payment. Works on
//               closed trips too. Uses the PUBLISHED form.
//   ?test=1     Real test — the normal flow (real HubSpot, Jotform, emails,
//               Stripe) plus a "Fill test answers" button that fills everything
//               except the email addresses (so the emails reach you), uploads a
//               small test image to each upload question, and signs the
//               permissions packet with a test signature.
//
// The dashboard's Trips & links tab has Preview / Test buttons for each trip.

/** Answers that pass validation (and keep "show when…" branches short). Pure. */
export function sampleValues(schema, stepKey, { keepEmails = false, current = {} } = {}) {
  const out = {};
  let n = 0;
  for (const st of schema?.steps || []) {
    if (st.key !== stepKey) continue;
    for (const sec of st.sections || []) for (const f of sec.fields || []) {
      if (['html', 'hidden', 'file'].includes(f.type) || f.hidden) continue;
      if (f.source) continue;
      n += 1;
      const opts = Array.isArray(f.options) ? f.options : [];
      const parentish = /^parent\d/i.test(f.key) || /contact|guardian/i.test(f.label || '');
      switch (f.type) {
        case 'fullname':
          out[f.key] = f.key === 'name' ? { first: 'Test', last: 'Student' } : { first: 'Test', last: `Parent ${n}` };
          break;
        case 'email':
          if (keepEmails) { if (current[f.key]) out[f.key] = current[f.key]; break; }
          out[f.key] = f.key === 'email' ? 'preview.student@example.com' : `preview.${f.key.toLowerCase()}@example.com`;
          break;
        case 'phone': out[f.key] = { cc: '64', number: `21 555 ${String(1000 + n).slice(-4)}` }; break;
        case 'date': out[f.key] = f.key === 'dob' ? '2010-05-14' : '2032-01-31'; break; // a 16-year-old; passport valid well past the trip
        case 'number': out[f.key] = /weight/i.test(f.label) ? '60' : /height/i.test(f.label) ? '170' : '1'; break;
        case 'address': out[f.key] = { addr_line1: '1 Test Street', addr_line2: '', city: 'Dunedin', state: 'Otago', postal: '9016' }; break;
        case 'select': case 'radio':
          out[f.key] = opts.includes('No') ? 'No' : opts.includes('Yes') && /confident|aware|hold a passport/i.test(f.label) ? 'Yes' : opts[0];
          break;
        case 'checkbox': out[f.key] = opts.length ? [opts.includes('Yes') ? 'Yes' : opts[0]] : []; break;
        case 'textarea': out[f.key] = 'Test answer — this application is a test.'; break;
        default:
          if (f.prefill && current[f.key]) { out[f.key] = current[f.key]; break; }
          out[f.key] = parentish && /name/i.test(f.label || '') ? `Test Parent${n > 1 ? ` ${n}` : ''}` : /relationship/i.test(f.label || '') ? 'Mother' : 'Test';
      }
    }
  }
  return out;
}

/** A small PNG File, for "Fill test answers" on upload questions in a real test. */
export async function testImageFile(name = 'test-upload.png') {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 200;
  const g = c.getContext('2d');
  g.fillStyle = '#eaf3f4'; g.fillRect(0, 0, 320, 200);
  g.fillStyle = '#2d6b74'; g.font = 'bold 22px sans-serif'; g.fillText('TEST UPLOAD', 80, 92);
  g.font = '14px sans-serif'; g.fillText('Unearthed application test', 76, 122);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new File([blob], name, { type: 'image/png' });
}

/** Fake server answers for preview mode. Pure (given a state factory). */
export function previewReply(action, body, { state, trip, kind = 'student' }) {
  switch (action) {
    case 'start': return { token: 'preview', app: state('application', body?.values || {}) };
    case 'save': return { ok: true };
    case 'submit': return { app: state('waiver', body?.values || {}), sync: {} };
    case 'send-waiver': return { app: state('waiting', {}, { status: 'sent', sentTo: body?.email || 'parent@example.com' }), emailed: true };
    case 'sign': return { app: state(trip?.schoolCollecting || kind === 'teacher' ? 'done' : 'deposit', {}, { status: 'signed', parentName: body?.input?.parentName }) };
    case 'checkout': return { preview: true };
    case 'resume': return { ok: true };
    default: return {};
  }
}

export const TEST_CSS = `
.pvbar{position:sticky;top:0;z-index:20;background:#231f20;color:#fff;font-size:14px;padding:10px 16px;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
.pvbar strong{color:#ffd56b}
.pvbar button{border:1px solid rgba(255,255,255,.35);background:transparent;color:#fff;border-radius:8px;padding:4px 10px;font:inherit;font-size:13px;cursor:pointer}
.pvbar button:hover{background:rgba(255,255,255,.12)}
.pvbar .fill{background:#ffd56b;color:#231f20;border-color:#ffd56b;font-weight:600}
.pvbar .jump{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.pvbar.test{background:#7a4a00}
`;
