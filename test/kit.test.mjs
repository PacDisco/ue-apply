// node test/kit.test.mjs — the pure parts: form engine, waiver, trips, sync helpers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import * as K from '../public/form-kit.mjs';
import * as W from '../public/waiver-kit.mjs';
import { buildTrip, splitProgramName } from '../netlify/functions/_lib/trips.mjs';
import { dealName, splitName, parentsOf, studentProps } from '../netlify/functions/_lib/sync.mjs';
import { verifyWebhook, bankMethodFor, minorUnits } from '../netlify/functions/_lib/stripe.mjs';
import { compose } from '../netlify/functions/_lib/notify.mjs';
import { fromJotformAnswer } from '../netlify/functions/_lib/import.mjs';
import { sampleValues, previewReply } from '../public/test-kit.mjs';

let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };
const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url)));

t('schema from the Jotform import lints clean; core fields where the flow needs them', () => {
  assert.deepEqual(K.lintSchema(schema), []);
  assert.deepEqual(K.stepFields(schema, 'step1').map((f) => f.key), ['name', 'email', 'dob']);
  const bad = JSON.parse(JSON.stringify(schema)); bad.steps[1].sections[0].fields.push({ key: 'x', qid: '3', type: 'text', label: 'Dup' });
  assert.ok(K.lintSchema(bad).some((l) => /both use Jotform field ID 3/.test(l.message)));
});
t('trip values fill hidden fields; prefill starts the school', () => {
  const trip = { name: 'Otago Boys High School - Borneo 2027', school: 'Otago Boys High School', currency: 'NZD' };
  const v = K.computeDerived(schema, {}, { trip, waiverSigned: true });
  assert.equal(v.program, trip.name); assert.equal(v.currency, 'NZD'); assert.equal(v.waiverSigned, 'Yes');
  assert.equal(K.prefillValues(schema, { trip }).school, 'Otago Boys High School');
});
t('conditions: medical detail only when they answered Yes', () => {
  const f = K.fieldByKey(schema, 'medicalMore');
  assert.equal(K.isVisible(schema, f, { asthma: 'No' }), false);
  assert.equal(K.isVisible(schema, f, { asthma: 'Yes' }), true);
  const r = K.validateStep(schema, 'step2', { asthma: 'No', medicalMore: 'left over' });
  assert.equal(r.clean.medicalMore, undefined);
});
t('student and parent emails must differ', () => {
  const r = K.validateStep(schema, 'step2', { parent1Email: 'a@b.nz' });
  assert.equal(r.errors.parent1Email, undefined);
  const e = K.uniquenessErrors(schema, 'step2', { email: 'a@b.nz', parent1Email: 'A@b.nz' });
  assert.match(e.parent1Email, /different from the student/);
});
t('card surcharge + age', () => {
  assert.deepEqual(K.withSurcharge(schema, 1750, 'card'), { base: 1750, rate: 0.03, surcharge: 52.5, total: 1802.5, method: 'card' });
  assert.equal(K.withSurcharge(schema, 1750, 'bank').total, 1750);
  assert.equal(K.ageOn('2008-11-10', '2026-11-09'), 17); assert.equal(K.ageOn('2008-11-09', '2026-11-09'), 18);
});
t('Jotform params: one form, files as URLs, checkbox fill', () => {
  const v = K.computeDerived(schema, { name: { first: 'A', last: 'B' }, passportPhoto: [{ id: 'f1', name: 'p.jpg' }], parent1Phone: { cc: '64', number: '21 1' } }, { trip: { name: 'T', currency: 'NZD' }, waiverSigned: true });
  const p = K.toJotformParams(schema, v, { fileUrl: (f) => `https://x/${f.id}` });
  assert.equal(p['submission[3][first]'], 'A'); assert.equal(p['submission[89]'], 'https://x/f1'); assert.equal(p['submission[75][0]'], 'Yes'); assert.equal(p['submission[64][full]'], '+64 21 1');
});
t('waiver: under-18 part, initials, signature, agreement', () => {
  assert.equal(W.partsFor(W.DEFAULT_WAIVER, { under18: false }).length, 2, 'every family signs both parts');
  const sig = 'data:image/png;base64,' + 'A'.repeat(400);
  const ok = W.validateSignature(W.DEFAULT_WAIVER, { parentName: 'Mere Rua', relationship: 'Mother', initials: { part1: 'm.r', part2: 'MR' }, signature: sig, agree: true }, { under18: false });
  assert.equal(ok.ok, true); assert.equal(ok.clean.initials.part1, 'MR');
  const bad = W.validateSignature(W.DEFAULT_WAIVER, { parentName: 'Mere', initials: {}, signature: 'x' }, { under18: true });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['agree', 'initials_part1', 'initials_part2', 'parentName', 'relationship', 'signature']);
  const blocks = W.htmlBlocks(W.DEFAULT_WAIVER.parts[0].html);
  assert.ok(blocks.some((b) => b.kind === 'h' && b.text === 'Assumption of Risks and Release from Liability'));
  assert.ok(blocks.some((b) => b.kind === 'li' && b.depth === 2));
});
t('trip: schedule falls back to the global record; closed by date / capacity', () => {
  const row = { slug: 's', program_id: '1', open: true };
  const tr = buildTrip(row, { properties: { unearthed_program: 'Wellington Girls College - Cambodia 2027', payment_amount_1: '1750', payment_amount_2: '1375', program_currency: '' } }, { properties: { payment_amount_3: '100', program_currency: 'NZD' } });
  assert.equal(tr.deposit, 1750); assert.equal(tr.total, 3225); assert.equal(tr.currency, 'NZD'); assert.equal(tr.destination, 'Cambodia 2027'); assert.equal(tr.open, true);
  assert.equal(buildTrip({ ...row, deposit: '500', currency: 'aud' }, { properties: {} }, null).deposit, 500);
  assert.equal(buildTrip({ ...row, closes_on: '2026-01-01' }, { properties: {} }, null, { today: '2026-02-01' }).closedReason, 'date');
  assert.equal(buildTrip({ ...row, capacity: 2 }, { properties: {} }, null, { paidCount: 2 }).closedReason, 'full');
  assert.equal(buildTrip({ ...row }, { properties: { school_collecting_payments: 'true' } }, null).schoolCollecting, true);
  assert.deepEqual(splitProgramName('Kambala School - New Zealand STEM 2027'), { school: 'Kambala School', destination: 'New Zealand STEM 2027' });
});
t('deal name + contacts', () => {
  assert.equal(dealName({ answers: { name: { first: 'Ruby Isla', last: 'Thornburgh' } } }, { destination: 'Nepal 2028' }), 'Ruby Isla Thornburgh — Nepal 2028');
  assert.deepEqual(splitName('Mere Te Rua'), { first: 'Mere Te', last: 'Rua' });
  const ps = parentsOf({ email: 'kid@x.nz', answers: { parent1Name: 'Mere Rua', parent1Email: 'MERE@x.nz', parent2Email: 'kid@x.nz' } });
  assert.equal(ps.length, 1); assert.equal(ps[0].email, 'mere@x.nz'); assert.equal(ps[0].props.lastname, 'Rua');
  const mapped = JSON.parse(JSON.stringify(schema)); K.fieldByKey(mapped, 'tshirt').hubspot = { contact: 'tshirt_size' };
  assert.equal(studentProps(mapped, { answers: { name: { first: 'A', last: 'B' }, tshirt: 'M', dob: '2010-01-02' } }).tshirt_size, 'M');
});
t('Stripe: webhook signature, bank method, minor units', () => {
  const body = JSON.stringify({ type: 'x' }); const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 's').update(`${ts}.${body}`).digest('hex');
  assert.equal(verifyWebhook(body, `t=${ts},v1=${sig}`, 's').type, 'x');
  assert.throws(() => verifyWebhook(body, `t=${ts},v1=${sig.replace(/.$/, '0')}`, 's'));
  assert.throws(() => verifyWebhook(body, `t=${ts - 4000},v1=${sig}`, 's'));
  assert.equal(bankMethodFor('NZD', {}), 'nz_bank_account'); assert.equal(bankMethodFor('AUD', {}), null);
  assert.equal(minorUnits(1802.5, 'NZD'), 180250); assert.equal(minorUnits(1000, 'JPY'), 1000);
});
t('emails: dashboard overrides + placeholders', () => {
  const m = compose('deposit', { student: 'Ana Rua', studentFirst: 'Ana', trip: 'Borneo', amount: 'NZD 1,750', link: 'https://p' }, { settings: { emails: { deposit: { subject: 'Got it, {{studentFirst}}' } } } });
  assert.equal(m.subject, 'Got it, Ana'); assert.match(m.text, /NZD 1,750/); assert.match(m.html, /<a href="https:\/\/p"/);
});
t('old Jotform answers convert to this form\'s shapes', () => {
  assert.equal(fromJotformAnswer({ type: 'date' }, { answer: { year: '2010', month: '3', day: '4' } }), '2010-03-04');
  assert.equal(fromJotformAnswer({ type: 'date' }, { answer: '03-04-2010' }), '2010-03-04');
  assert.deepEqual(fromJotformAnswer({ type: 'phone' }, { answer: { full: '+64 21 555' } }), { cc: '64', number: '21 555' });
  assert.deepEqual(fromJotformAnswer({ type: 'checkbox' }, { answer: 'A\nB' }), ['A', 'B']);
  assert.equal(fromJotformAnswer({ type: 'text' }, { answer: '' }), undefined);
});
t('test answers pass every check on both pages (and keep typed emails in a real test)', () => {
  const s1 = sampleValues(schema, 'step1');
  const s2 = sampleValues(schema, 'step2');
  const all = { ...s1, ...s2, passportPhoto: [{ id: 'x', name: 'p.png' }] };
  assert.deepEqual(K.validateStep(schema, 'step1', all).errors, {});
  assert.deepEqual(K.validateStep(schema, 'step2', all).errors, {});
  assert.equal(K.ageOn(s1.dob, '2026-11-09') < 18, true);
  const kept = sampleValues(schema, 'step1', { keepEmails: true, current: { email: 'me@x.nz' } });
  assert.equal(kept.email, 'me@x.nz');
  assert.equal(sampleValues(schema, 'step2', { keepEmails: true }).parent1Email, undefined, 'left for the tester to type');
  assert.equal(sampleValues(schema, 'step2', { current: { school: 'Otago Boys' } }).school, 'Otago Boys', 'prefilled school kept');
});
t('preview replies walk the steps without a server', () => {
  const state = (step, answers, waiver) => ({ step, answers, waiver });
  assert.equal(previewReply('start', { values: { a: 1 } }, { state }).app.step, 'application');
  assert.equal(previewReply('submit', {}, { state }).app.step, 'waiver');
  assert.equal(previewReply('send-waiver', { email: 'p@x' }, { state }).app.waiver.sentTo, 'p@x');
  assert.equal(previewReply('sign', {}, { state, trip: {} }).app.step, 'deposit');
  assert.equal(previewReply('sign', {}, { state, trip: { schoolCollecting: true } }).app.step, 'done');
  assert.equal(previewReply('checkout', {}, { state }).preview, true);
});
console.log(`${n} passed`);

// Added questions get their own IDs (x10000, x10001…), and duplicates from older drafts are repaired.
{
  const { nextQid, repairSyntheticQids, lintSchema } = await import('../public/form-kit.mjs');
  const s = { steps: [{ key: 'step1', sections: [{ fields: [
    { key: 'name', qid: '3', type: 'fullname', label: 'Name' },
    { key: 'email', qid: '4', type: 'email', label: 'Email' },
    { key: 'parentName', qid: 'x10000', type: 'text', label: 'Parent Name' },
    { key: 'parentsEmail', qid: 'x10000', type: 'email', label: "Parent's Email" },
  ] }] }] };
  assert.equal(nextQid(s), '10001');
  assert.ok(lintSchema(s).some((l) => /both use Jotform field ID x10000/.test(l.message)));
  assert.equal(repairSyntheticQids(s), 1);
  assert.equal(s.steps[0].sections[0].fields[3].qid, 'x10001');
  assert.ok(!lintSchema(s).some((l) => /both use/.test(l.message)));
  assert.equal(repairSyntheticQids(s), 0);
  console.log('ok synthetic qids');
}

// Teacher form: the student form minus guardians, plus one emergency contact.
{
  const K2 = await import('../public/form-kit.mjs');
  const { schema: t, removed } = K2.teacherSchemaFrom(schema);
  const keys = K2.allFields(t).map(({ field }) => field.key);
  for (const k of ['parent1Name', 'parent1Email', 'parent1Phone', 'parent1Relationship', 'secondary', 'parent2Name', 'parent2Email', 'q73']) assert.ok(!keys.includes(k), `removed ${k}`);
  for (const k of ['name', 'email', 'dob', 'passportNumber', 'passportPhoto', 'asthma', 'program', 'waiverSigned', 'currency', 'emergencyName', 'emergencyRelationship', 'emergencyPhone', 'emergencyEmail']) assert.ok(keys.includes(k), `kept/added ${k}`);
  assert.ok(removed.includes('Primary Contact Name') || removed.length >= 6);
  assert.equal(K2.formKind(t), 'teacher'); assert.equal(t.settings.jotform.formId, K2.TEACHER_FORM_ID);
  assert.deepEqual(K2.lintSchema(t).filter((l) => l.level === 'error'), [], JSON.stringify(K2.lintSchema(t)));
  assert.ok(K2.lintSchema(schema).length === 0 || !K2.lintSchema(schema).some((l) => /parent1/.test(l.message)));
  const ids = K2.allFields(t).map(({ field }) => field.qid).filter((q) => /^x/.test(q));
  assert.equal(new Set(ids).size, ids.length, 'unique new IDs');
  // Emergency contact can't reuse the teacher's own email.
  const errs = K2.uniquenessErrors(t, 'step2', { email: 'a@b.nz', emergencyEmail: 'A@b.nz' });
  assert.match(errs.emergencyEmail, /your own email/);
  // The student form itself is untouched.
  assert.ok(K2.allFields(schema).some(({ field }) => field.key === 'parent1Name'));
  console.log('ok teacher form');
}
