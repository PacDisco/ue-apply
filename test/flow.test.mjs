// node test/flow.test.mjs
//   The whole flow against a local Postgres (TEST_PG_URL, default
//   postgres://postgres@127.0.0.1:55432/apply): about you → application →
//   permissions packet (here and by email) → deposit, plus Add from HubSpot.
//   HubSpot, Jotform, Stripe, Blobs and email are fakes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';

process.env.HUBSPOT_TOKEN = 'hs'; process.env.JOTFORM_API_KEY = 'jf'; process.env.STRIPE_SECRET_KEY = 'sk';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec'; process.env.APPLY_SERVICE_KEY = 'svc'; process.env.APPLY_SITE_URL = 'https://apply.test';
process.env.UE_APPLY_ALERT_EMAIL = 'team@ue.test';

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };
const pool = new pg.Pool({ connectionString: process.env.TEST_PG_URL || 'postgres://postgres@127.0.0.1:55432/apply' });
try { await pool.query('select 1'); } catch { console.log('  – flow tests skipped (no Postgres)'); process.exit(0); }
await pool.query(readFileSync(new URL('./MIGRATION-ue-apply.sql', import.meta.url), 'utf8'));
await pool.query('TRUNCATE ue_apply_files, ue_applications, ue_apply_trips, ue_apply_form_versions, ue_apply_forms CASCADE');
const sql = { query: async (text, p = []) => (await pool.query(text, p)).rows };

const db = await import('../netlify/functions/_lib/db.mjs');
db.__setSql(sql);
const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url)));
await pool.query(`INSERT INTO ue_apply_forms (id, draft, draft_rev, published, published_rev) VALUES ('ue-application', $1, 3, $1, 3)`, [JSON.stringify(schema)]);
await pool.query(`INSERT INTO ue_apply_trips (slug, program_id, program_name, open) VALUES ('otago-borneo-2027', '57951798456', 'Otago Boys High School - Borneo 2027', true)`);

// ── fakes ──────────────────────────────────────────────────────────────────
const H = { contacts: new Map(), deals: new Map(), assoc: [], notes: [], files: 0, next: 1000 };
const programs = {
  '57951798456': { unearthed_program: 'Otago Boys High School - Borneo 2027', program_currency: 'NZD', payment_amount_2: '1375', payment_amount_3: '1375' },
  '50506535214': { unearthed_program: 'Global Portal Information', payment_amount_1: '1750' },
};
const LABELS = { 'contacts|contacts': [{ category: 'USER_DEFINED', typeId: 1, label: 'Parent' }], 'contacts|2-58156993': [{ category: 'USER_DEFINED', typeId: 7, label: 'Student' }, { category: 'USER_DEFINED', typeId: 8, label: 'Parent' }], 'deals|2-58156993': [] };
const res = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Map() });
const hubspot = async (url, opts = {}) => {
  const u = new URL(url); const p = u.pathname; const m = opts.method || 'GET';
  const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
  if (p === '/crm/v3/objects/contacts/search') {
    const e = body.filterGroups[0].filters[0].value;
    const hit = [...H.contacts.values()].find((c) => c.properties.email === e);
    return res({ results: hit ? [hit] : [] });
  }
  if (p === '/crm/v3/objects/contacts' && m === 'POST') { const id = String(H.next++); H.contacts.set(id, { id, properties: { ...body.properties } }); return res({ id }); }
  let mm;
  if ((mm = /^\/crm\/v3\/objects\/contacts\/(\d+)$/.exec(p)) && m === 'PATCH') { Object.assign(H.contacts.get(mm[1]).properties, body.properties); return res({ id: mm[1] }); }
  if ((mm = /^\/crm\/v3\/objects\/2-58156993\/(\d+)$/.exec(p))) return programs[mm[1]] ? res({ id: mm[1], properties: programs[mm[1]] }) : res({}, 404);
  if ((mm = /^\/crm\/v4\/associations\/([^/]+)\/([^/]+)\/labels$/.exec(p))) return res({ results: LABELS[`${mm[1]}|${mm[2]}`] || [] });
  if ((mm = /^\/crm\/v4\/objects\/([^/]+)\/(\d+)\/associations\/(?:default\/)?([^/]+)\/(\d+)$/.exec(p)) && m === 'PUT') { H.assoc.push({ from: `${mm[1]}:${mm[2]}`, to: `${mm[3]}:${mm[4]}`, types: body }); return res({}); }
  if (p === '/crm/v3/pipelines/deals/836668844') return res({ id: '836668844', stages: [{ id: 'st-app', label: 'Application Complete', displayOrder: 0 }, { id: 'st-dep', label: 'Deposit Paid', displayOrder: 1 }] });
  if (p === '/crm/v3/objects/deals' && m === 'POST') { const id = String(H.next++); H.deals.set(id, { id, properties: { ...body.properties } }); return res({ id }); }
  if ((mm = /^\/crm\/v3\/objects\/deals\/(\d+)$/.exec(p))) return H.deals.get(mm[1]) ? res(H.deals.get(mm[1])) : res({}, 404);
  if ((mm = /^\/crm\/v4\/objects\/contacts\/(\d+)\/associations\/deals$/.exec(p))) return res({ results: H.assoc.filter((a) => a.to === `contacts:${mm[1]}` && a.from.startsWith('deals:')).map((a) => ({ toObjectId: a.from.split(':')[1] })) });
  if ((mm = /^\/crm\/v4\/objects\/contacts\/(\d+)\/associations\/2-58156993$/.exec(p))) return res({ results: H.assoc.filter((a) => a.from === `contacts:${mm[1]}` && a.to.startsWith('2-58156993:')).map((a) => ({ toObjectId: a.to.split(':')[1] })) });
  if (p === '/crm/v3/objects/deals/batch/read') return res({ results: body.inputs.map((i) => H.deals.get(i.id)).filter(Boolean) });
  if (p === '/files/v3/files') { H.files += 1; return res({ id: `file-${H.files}` }); }
  if (p === '/crm/v3/objects/notes') { H.notes.push(body); return res({ id: `note-${H.notes.length}` }); }
  throw new Error(`unhandled HubSpot ${m} ${p}`);
};
const HS = await import('../netlify/functions/_lib/hubspot.mjs');
HS.__setFetch(hubspot);

const J = { subs: new Map(), next: 5000 };
const jotform = async (url, opts = {}) => {
  const u = new URL(url);
  const params = opts.body ? Object.fromEntries(new URLSearchParams(opts.body)) : {};
  let mm;
  if ((mm = /^\/form\/(\d+)\/submissions$/.exec(u.pathname)) && opts.method === 'POST') { const id = String(J.next++); J.subs.set(id, { form: mm[1], params }); return res({ responseCode: 200, content: { submissionID: id } }); }
  if ((mm = /^\/submission\/(\d+)$/.exec(u.pathname)) && opts.method === 'POST') { Object.assign(J.subs.get(mm[1]).params, params); return res({ responseCode: 200, content: {} }); }
  if ((mm = /^\/form\/(\d+)\/submissions$/.exec(u.pathname))) {
    return res({ responseCode: 200, content: mm[1] === '251396787451873' ? [{ id: '999', created_at: '2026-05-01 10:00:00', status: 'ACTIVE', answers: {
      3: { type: 'control_fullname', answer: { first: 'Ruby', last: 'Old' } }, 4: { type: 'control_email', answer: 'ruby@old.nz' },
      76: { type: 'control_datetime', answer: { year: '2010', month: '03', day: '04' } }, 11: { type: 'control_radio', answer: 'M' },
      89: { type: 'control_fileupload', answer: ['https://www.jotform.com/uploads/x/251396787451873/999/passport.jpg'] },
    } }] : [] });
  }
  throw new Error(`unhandled Jotform ${u.pathname}`);
};
const S = { sessions: new Map() };
const stripe = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.pathname === '/v1/checkout/sessions' && opts.method === 'POST') {
    const p = new URLSearchParams(opts.body);
    const id = `cs_test_${S.sessions.size + 1}`;
    const meta = {}; for (const [k, v] of p) { const m = /^metadata\[(.+)\]$/.exec(k); if (m) meta[m[1]] = v; }
    const s = { id, url: `https://checkout.stripe.com/${id}`, metadata: meta, amount_total: Number(p.get('line_items[0][price_data][unit_amount]')), currency: p.get('line_items[0][price_data][currency]'), payment_method_types: [p.get('payment_method_types[0]')], payment_status: 'unpaid' };
    S.sessions.set(id, s); return res(s);
  }
  const m = /^\/v1\/checkout\/sessions\/(cs_[\w]+)$/.exec(u.pathname);
  if (m) return res(S.sessions.get(m[1]));
  throw new Error(`unhandled Stripe ${u.pathname}`);
};
globalThis.fetch = async (url, opts) => (String(url).includes('jotform.com') ? jotform(url, opts) : String(url).includes('stripe.com') ? stripe(url, opts) : hubspot(url, opts));
const ST = await import('../netlify/functions/_lib/stripe.mjs'); ST.__setFetch(stripe);
const blobs = new Map();
(await import('../netlify/functions/_lib/blobs.mjs')).__setStore({ set: async (k, v, o) => blobs.set(k, { v, o }), get: async (k) => blobs.get(k)?.v || null });
const mails = [];
(await import('../netlify/functions/_lib/notify.mjs')).__setTransport({ sendMail: async (m) => { mails.push(m); return { messageId: `m${mails.length}` }; } });

const { default: apply } = await import('../netlify/functions/apply.mjs');
const { default: upload } = await import('../netlify/functions/upload.mjs');
const { default: file } = await import('../netlify/functions/file.mjs');
const { default: service } = await import('../netlify/functions/service.mjs');
const { default: webhook } = await import('../netlify/functions/stripe-webhook.mjs');
const call = async (body, qs = '') => {
  const r = await apply(new Request(`https://apply.test/api/apply${qs}`, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}), { ip: '203.0.113.9' });
  return { status: r.status, body: await r.json() };
};
const svc = async (body) => { const r = await service(new Request('https://apply.test/api/service', { method: 'POST', body: JSON.stringify(body), headers: { 'x-apply-key': 'svc' } })); return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.arrayBuffer() }; };
// A real 1×1 PNG so jsPDF can embed it.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' ;

console.log('flow');
let token;
await t('launch link: trip, deposit from the global schedule, school prefilled', async () => {
  const r = await call(null, '?trip=otago-borneo-2027');
  assert.equal(r.status, 200);
  assert.equal(r.body.trip.deposit, 1750); assert.equal(r.body.trip.currency, 'NZD'); assert.equal(r.body.trip.school, 'Otago Boys High School'); assert.equal(r.body.trip.destination, 'Borneo 2027');
  assert.equal(r.body.prefill.school, 'Otago Boys High School');
  assert.equal((await call(null, '?trip=nope')).status, 404);
});
await t('about you: validates, creates the row + HubSpot contact', async () => {
  assert.equal((await call({ action: 'start', trip: 'otago-borneo-2027', values: { email: 'x' } })).status, 400);
  const r = await call({ action: 'start', trip: 'otago-borneo-2027', values: { name: { first: 'Ana', last: 'Rua' }, email: 'Ana@Rua.nz', dob: '2010-02-03' }, attribution: { utm_source: 'school' } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); token = r.body.token; assert.equal(r.body.app.step, 'application');
  const c = [...H.contacts.values()].find((x) => x.properties.email === 'ana@rua.nz');
  assert.equal(c.properties.firstname, 'Ana'); assert.equal(c.properties.date_of_birth, '2010-02-03'); assert.equal(c.properties.company_tag, 'Unearthed Education');
});
await t('starting again with the same email emails a link instead of exposing the application', async () => {
  const before = mails.length;
  const r = await call({ action: 'start', trip: 'otago-borneo-2027', values: { name: { first: 'X', last: 'Y' }, email: 'ana@rua.nz', dob: '2010-02-03' } });
  assert.equal(r.body.emailed, true); assert.equal(r.body.token, undefined);
  assert.equal(mails.length, before + 1); assert.match(mails.at(-1).text, /https:\/\/apply\.test\/otago-borneo-2027\?t=/);
  token = decodeURIComponent(/\?t=([^\s]+)/.exec(mails.at(-1).text)[1]); // the old token was rotated
});
let passportId;
await t('upload: images/PDF only, stored, served to the portals with the key only', async () => {
  const fd = new FormData(); fd.append('token', token); fd.append('field', 'passportPhoto'); fd.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), 'passport.jpg');
  const r = await upload(new Request('https://apply.test/api/upload', { method: 'POST', body: fd }));
  const rec = await r.json(); assert.equal(r.status, 200, JSON.stringify(rec)); passportId = rec.id;
  const bad = new FormData(); bad.append('token', token); bad.append('field', 'passportPhoto'); bad.append('file', new Blob(['x'], { type: 'text/html' }), 'x.html');
  assert.equal((await upload(new Request('https://apply.test/api/upload', { method: 'POST', body: bad }))).status, 415);
  assert.equal((await file(new Request(`https://apply.test/api/file/${passportId}`), { params: { id: passportId } })).status, 403);
  const ok = await file(new Request(`https://apply.test/api/file/${passportId}`, { headers: { 'x-apply-key': 'svc' } }), { params: { id: passportId } });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'image/jpeg');
});
await t('application: conditions apply; HubSpot contacts, deal, program links; Jotform mirror', async () => {
  const values = { school: 'Otago Boys High School', tshirt: 'M', asthma: 'No', holdPassport: 'Yes', passportNumber: 'LA1234567', passportPhoto: [{ id: passportId, name: 'passport.jpg' }],
    parent1Name: 'Mere Rua', parent1Email: 'mere@rua.nz', parent1Phone: { cc: '64', number: '21 555 1234' }, parent1Relationship: 'Mother', secondary: 'No' };
  const miss = await call({ action: 'submit', token, values: { ...values, tshirt: '' } });
  assert.equal(miss.status, 400); assert.ok(miss.body.fields.tshirt);
  const r = await call({ action: 'submit', token, values });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.app.step, 'waiver');
  assert.deepEqual(r.body.sync, { contact: true, parents: true, deal: true, program: true, jotform: true });
  const deal = [...H.deals.values()][0].properties;
  assert.equal(deal.dealname, 'Ana Rua — Borneo 2027'); assert.equal(deal.pipeline, '836668844'); assert.equal(deal.dealstage, 'st-app'); assert.equal(deal.amount, '4500');
  const mere = [...H.contacts.values()].find((c) => c.properties.email === 'mere@rua.nz');
  assert.equal(mere.properties.firstname, 'Mere'); assert.equal(mere.properties.lastname, 'Rua');
  assert.ok(H.assoc.some((a) => a.from === `contacts:${mere.id}` && a.to.startsWith('contacts:') && a.types?.[0]?.associationTypeId === 1), 'parent labelled Parent');
  assert.ok(H.assoc.some((a) => a.to === '2-58156993:57951798456' && a.types?.[0]?.associationTypeId === 7), 'student labelled Student on the program');
  const sub = [...J.subs.values()][0];
  assert.equal(sub.form, '251396787451873');
  assert.equal(sub.params['submission[3][first]'], 'Ana'); assert.equal(sub.params['submission[14]'], 'Otago Boys High School - Borneo 2027');
  assert.equal(sub.params['submission[78]'], 'NZD'); assert.equal(sub.params['submission[89]'], `https://apply.test/api/file/${passportId}`);
  assert.equal(sub.params['submission[75][0]'], undefined, 'not signed yet');
  assert.equal(sub.params['submission[26]'], undefined, 'hidden branch not sent');
  assert.ok(mails.some((m) => m.subject.startsWith('New Unearthed application')));
});
await t('permissions packet: emailed to the parent, then signed from the link; PDF to HubSpot; Jotform ticked', async () => {
  const r = await call({ action: 'send-waiver', token, email: 'mere@rua.nz' });
  assert.equal(r.status, 200); assert.equal(r.body.app.step, 'deposit', 'can pay while waiting');
  const m = mails.at(-1); assert.equal(m.to, 'mere@rua.nz'); const signToken = decodeURIComponent(/\/sign\?t=([^\s]+)/.exec(m.text)[1]);
  const info = await call(null, `?sign=${encodeURIComponent(signToken)}`);
  assert.equal(info.body.student, 'Ana Rua'); assert.equal(info.body.under18, true); assert.equal(info.body.waiver.parts.length, 2);
  const bad = await call({ action: 'sign', signToken, input: { parentName: 'Mere', relationship: '', initials: {}, signature: '', agree: false } });
  assert.equal(bad.status, 400); assert.ok(bad.body.fields.parentName && bad.body.fields.signature && bad.body.fields.initials_part2);
  const big = 'data:image/png;base64,' + crypto.randomBytes(600).toString('base64');
  const ok = await call({ action: 'sign', signToken, input: { parentName: 'Mere Rua', relationship: 'Mother', initials: { part1: 'mr', part2: 'MR' }, signature: big, agree: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.app.waiver.status, 'signed');
  const [row] = await sql.query(`SELECT waiver, waiver_signature, status, sync FROM ue_applications WHERE lower(email) = 'ana@rua.nz'`);
  assert.equal(row.waiver.initials.part1, 'MR'); assert.equal(row.waiver.ip, '203.0.113.9'); assert.equal(row.status, 'signed');
  assert.ok(row.waiver.text.parts[0].html.includes('Assumption of Risks'), 'signed wording stored');
  assert.equal(row.sync.waiverPdf.ok, true); assert.equal(H.notes.length, 1); assert.ok(H.notes[0].properties.hs_attachment_ids);
  assert.ok(mails.some((m) => /^Signed: permissions packet/.test(m.subject) && m.attachments?.[0]?.filename.endsWith('.pdf')));
  assert.equal([...J.subs.values()][0].params['submission[75][0]'], 'Yes');
  assert.equal((await call({ action: 'sign', signToken, input: {} })).body.already, true);
});
await t('signed PDF builds with a real signature image', async () => {
  const { waiverPdf } = await import('../netlify/functions/_lib/pdf.mjs');
  const { DEFAULT_WAIVER } = await import('../public/waiver-kit.mjs');
  const bytes = waiverPdf({ waiver: DEFAULT_WAIVER, under18: true, student: { name: 'Ana Rua', dob: '2010-02-03' }, trip: { name: 'Otago Boys High School - Borneo 2027' }, signed: { parentName: 'Mere Rua', relationship: 'Mother', initials: { part1: 'MR', part2: 'MR' }, signature: PNG, signedAt: new Date().toISOString(), ip: '203.0.113.9' } });
  assert.equal(String.fromCharCode(...bytes.slice(0, 5)), '%PDF-'); assert.ok(bytes.length > 8000);
});
await t('deposit: card adds 3%; Stripe gets the deal id + base amount; webhook marks paid once', async () => {
  const r = await call({ action: 'checkout', token, method: 'card' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = [...S.sessions.values()][0];
  assert.equal(s.amount_total, 180250); assert.equal(s.currency, 'nzd'); assert.equal(s.payment_method_types[0], 'card');
  assert.equal(s.metadata.hubspot_deal_id, [...H.deals.keys()][0]); assert.equal(s.metadata.base_amount, '1750'); assert.equal(s.metadata.source, 'ue-apply');
  const bank = await call({ action: 'checkout', token, method: 'bank' });
  assert.equal([...S.sessions.values()][1].payment_method_types[0], 'nz_bank_account'); assert.equal([...S.sessions.values()][1].amount_total, 175000);
  // Stripe calls back.
  const ev = JSON.stringify({ type: 'checkout.session.completed', data: { object: { ...s, payment_status: 'paid', payment_intent: 'pi_X' } } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec').update(`${ts}.${ev}`).digest('hex');
  const before = mails.length;
  const w = await webhook(new Request('https://apply.test/api/stripe-webhook', { method: 'POST', body: ev, headers: { 'stripe-signature': `t=${ts},v1=${sig}` } }));
  assert.equal(w.status, 200);
  await webhook(new Request('https://apply.test/api/stripe-webhook', { method: 'POST', body: ev, headers: { 'stripe-signature': `t=${ts},v1=${sig}` } }));
  const sent = mails.slice(before);
  assert.equal(sent.filter((m) => /^Deposit received/.test(m.subject)).length, 1, 'confirmation once');
  assert.equal(sent.find((m) => /^Deposit received/.test(m.subject)).cc, 'mere@rua.nz');
  const bad = await webhook(new Request('https://apply.test/api/stripe-webhook', { method: 'POST', body: ev, headers: { 'stripe-signature': `t=${ts},v1=deadbeef` } }));
  assert.equal(bad.status, 400);
  const back = await call(null, `?token=${encodeURIComponent(token)}`);
  assert.equal(back.body.app.step, 'done'); assert.equal(back.body.app.deposit.status, 'paid');
  assert.equal(bank.status, 200);
});
await t('closed trip refuses new starts; resume still works', async () => {
  await pool.query(`UPDATE ue_apply_trips SET open = false WHERE slug = 'otago-borneo-2027'`);
  (await import('../netlify/functions/_lib/trips.mjs')).__clearTripCache();
  const r = await call({ action: 'start', trip: 'otago-borneo-2027', values: { name: { first: 'Z', last: 'Z' }, email: 'z@z.nz', dob: '2010-01-01' } });
  assert.equal(r.status, 409);
  assert.equal((await call(null, `?token=${encodeURIComponent(token)}`)).status, 200);
  await pool.query(`UPDATE ue_apply_trips SET open = true WHERE slug = 'otago-borneo-2027'`);
});
await t('service: key required; resync; Add from HubSpot imports the Jotform applicant', async () => {
  assert.equal((await service(new Request('https://apply.test/api/service', { method: 'POST', body: '{}' }))).status, 403);
  const [app] = await sql.query(`SELECT id FROM ue_applications WHERE lower(email) = 'ana@rua.nz'`);
  const rs = await svc({ action: 'resync', id: app.id, only: ['jotform'] });
  assert.equal(rs.body.result.jotform.ok, true); assert.equal(rs.body.result.jotform.updated, true);
  // An old Jotform applicant who already has a contact + deal.
  H.contacts.set('77', { id: '77', properties: { email: 'ruby@old.nz', firstname: 'Ruby', lastname: 'Old' } });
  H.deals.set('88', { id: '88', properties: { dealname: 'Ruby Old — Borneo 2027', pipeline: '836668844', dealstage: 'st-dep', createdate: '2026-05-01' } });
  H.assoc.push({ from: 'deals:88', to: 'contacts:77' }, { from: 'contacts:77', to: '2-58156993:57951798456' });
  const look = await svc({ action: 'lookup', email: 'ruby@old.nz' });
  assert.equal(look.body.contact.id, '77'); assert.equal(look.body.deals[0].id, '88'); assert.equal(look.body.programs[0].slug, 'otago-borneo-2027'); assert.equal(look.body.jotform.id, '999');
  const imp = await svc({ action: 'import', email: 'ruby@old.nz', actor: 'Jake' });
  assert.equal(imp.status, 200, JSON.stringify(imp.body)); const a = imp.body.app;
  assert.equal(a.status, 'imported'); assert.equal(a.hubspot_deal_id, '88'); assert.equal(a.jotform_submission_id, '999');
  assert.equal(a.answers.dob, '2010-03-04'); assert.equal(a.answers.tshirt, 'M'); assert.equal(a.answers.passportPhoto[0].url, 'https://www.jotform.com/uploads/x/251396787451873/999/passport.jpg');
  assert.equal((await svc({ action: 'import', email: 'ruby@old.nz' })).status, 409);
});

await pool.end();
console.log(`${n} passed`);
