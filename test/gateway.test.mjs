// node test/gateway.test.mjs — the portals' data source, pure parts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as G from '../netlify/functions/_lib/jf-gateway.mjs';

const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url)));
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };

t('edit keys: underscore and bracket forms', () => {
  assert.deepEqual(G.parseEditKey('submission[3_first]'), { qid: '3', sub: 'first' });
  assert.deepEqual(G.parseEditKey('submission[3][last]'), { qid: '3', sub: 'last' });
  assert.deepEqual(G.parseEditKey('submission[44]'), { qid: '44', sub: null });
  assert.deepEqual(G.parseEditKey('submission[x10000]'), { qid: 'x10000', sub: null });
  assert.equal(G.parseEditKey('other'), null);
});

t('edits: names, dates part by part, phones, choices; files and unknown IDs refused', () => {
  const before = { name: { first: 'Ana', last: 'Rua' }, dob: '2010-02-03', tshirt: 'M', passportPhoto: [{ id: 'f1' }], medicalMore: 'x' };
  const r = G.applyEdit(schema, before, [
    ['submission[3_last]', 'Rua-Smith'], ['submission[76_month]', '7'], ['submission[76_year]', '2009'],
    ['submission[11]', 'L'], ['submission[64]', '021 555 1234'], ['submission[89]', 'x'], ['submission[999]', 'y'], ['submission[26]', ''],
  ]);
  assert.deepEqual(r.answers.name, { first: 'Ana', last: 'Rua-Smith' });
  assert.equal(r.answers.dob, '2009-07-03');
  assert.equal(r.answers.tshirt, 'L');
  assert.deepEqual(r.answers.parent1Phone, { cc: '', number: '021 555 1234' });
  assert.equal(r.answers.medicalMore, undefined, 'cleared');
  assert.deepEqual(r.answers.passportPhoto, [{ id: 'f1' }]);
  assert.deepEqual(r.ignored, ['submission[89]', 'submission[999]']);
  assert.deepEqual(before.name.last, 'Rua', 'input not mutated');
});

t('submission shape: Jotform types, ids, withdrawn = deleted', () => {
  const app = { id: 'u', submission_id: '9123', status: 'applied', step2_at: '2026-11-01T02:03:04Z', updated_at: '2026-11-02T00:00:00Z', trip_slug: 'x', program_name: 'Otago Boys High School - Borneo 2027',
    answers: { name: { first: 'A', last: 'B' }, email: 'a@b.nz', dob: '2010-02-03', passportPhoto: [{ id: 'abc' }], parent1Phone: { cc: '64', number: '21 1' } }, waiver: { status: 'signed' } };
  const s = G.toSubmission(app, schema, { fileUrl: (f) => `https://apply.test/api/file/${f.id}` });
  assert.equal(s.id, '9123'); assert.equal(s.form_id, '251396787451873'); assert.equal(s.created_at, '2026-11-01 02:03:04'); assert.equal(s.status, 'ACTIVE');
  assert.equal(s.answers['3'].type, 'control_fullname'); assert.deepEqual(s.answers['3'].answer, { first: 'A', last: 'B' });
  assert.equal(s.answers['76'].answer.year, '2010');
  assert.deepEqual(s.answers['89'].answer, ['https://apply.test/api/file/abc']); assert.equal(s.answers['89'].type, 'control_fileupload');
  assert.equal(s.answers['64'].answer.full, '+64 21 1');
  assert.equal(s.answers['14'].answer, 'Otago Boys High School - Borneo 2027', 'program filled from the trip'); assert.deepEqual(s.answers['75'].answer, ['Yes']);
  assert.equal(G.toSubmission({ ...app, status: 'withdrawn' }, schema, { fileUrl: () => '' }).status, 'DELETED');
});

t('merge: ours replaces the Jotform copy; database-only ones lead page 1 only', () => {
  const ours = [
    { app: { jotform_submission_id: '5001' }, sub: { id: '5001', mine: true, status: 'ACTIVE' } },
    { app: { jotform_submission_id: null }, sub: { id: '9001', mine: true, status: 'ACTIVE' } },
    { app: { jotform_submission_id: null }, sub: { id: '9002', mine: true, status: 'DELETED' } },
  ];
  const page = G.mergePage([{ id: '5001' }, { id: '4000' }], ours, { offset: 0 });
  assert.deepEqual(page.map((s) => s.id), ['9001', '5001', '4000']);
  assert.ok(page[1].mine);
  assert.deepEqual(G.mergePage([{ id: '4000' }], ours, { offset: 1000 }).map((s) => s.id), ['4000']);
  const own = G.ownPage(ours, { offset: 0, limit: 1 });
  assert.equal(own.content.length, 1); assert.ok(!own.content.some((s) => s.status === 'DELETED'));
});

console.log(`${n} passed`);
