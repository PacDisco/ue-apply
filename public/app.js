// The Unearthed application flow: apply.unearthededucation.org/<trip-slug>
// About you → Application → Permissions packet → Deposit.
// Teachers: apply.unearthededucation.org/<trip-slug>/teacher — their own form,
// About you → Application → Waiver (they sign it themselves) → done.
// The server holds everything; the browser keeps only a resume token per trip.
import * as K from './form-kit.mjs';
import { renderWaiver, WAIVER_CSS } from './waiver-ui.mjs';
import { renderDeposit } from './deposit-ui.mjs';
import { sampleValues, testImageFile, previewReply, TEST_CSS } from './test-kit.mjs';

const $ = (s, r = document) => r.querySelector(s);
const esc = K.esc;
const view = $('#view');
const style = document.createElement('style');
style.textContent = K.FORM_CSS + WAIVER_CSS + TEST_CSS;
document.head.appendChild(style);

const pathParts = location.pathname.replace(/^\/+|\/+$/g, '').split('/');
const slug = decodeURIComponent(pathParts[0] || '').toLowerCase();
// /<trip>/teacher and /<trip>/leader: the same teacher form; the link sets the role.
const SEG = String(pathParts[1] || '').toLowerCase();
const KIND = SEG === 'teacher' || SEG === 'leader' ? 'teacher' : 'student';
const TEACHER = KIND === 'teacher';
const ROLE = SEG === 'leader' ? 'Trip Leader' : 'Teacher';
const ROLE_LC = ROLE.toLowerCase();
const BASE = `/${slug}${TEACHER ? `/${SEG}` : ''}`;
const params = new URLSearchParams(location.search);
const TOKEN_KEY = `ue-apply:${slug}${TEACHER ? ':teacher' : ''}`;
const S = { trip: null, form: null, app: null, token: null, prefill: {}, form1: null, form2: null, waiverUi: null };
// ?preview=1: nothing saved or sent. ?test=1: real run with a "Fill test answers" button. See test-kit.mjs.
const PREVIEW = params.get('preview') === '1';
const TESTING = PREVIEW || params.get('test') === '1';

const store = {
  get() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode: token lives for this page only */ } },
  clear() { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

async function api(method, body, qs = '') {
  if (PREVIEW && method === 'POST') return previewReply(body?.action, body, { state: previewState, trip: S.trip, kind: KIND });
  const res = await fetch(`/api/apply${qs}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Something went wrong (${res.status}).`), { status: res.status, fields: data?.fields });
  return data;
}

function notice(kind, html) {
  $('#notice').innerHTML = html ? `<div class="notice ${kind}" role="status">${html}</div>` : '';
  if (html) $('#notice').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function header() {
  const t = S.trip;
  $('#tripHead').innerHTML = t ? `<strong>${esc(t.destination || t.name)}</strong>${esc(t.school || '')}` : '';
  document.title = t ? `${TEACHER ? `${ROLE} application` : 'Apply'} — ${t.name} — Unearthed Education` : 'Apply — Unearthed Education';
}

function steps(active) {
  const order = ['about', 'application', 'waiver', 'deposit'];
  if (active === 'waiting') active = 'waiver';
  const el = $('#steps');
  if (S.trip?.schoolCollecting || TEACHER) el.querySelector('[data-s=deposit]').classList.add('hidden');
  if (TEACHER) el.querySelector('[data-s=waiver]').textContent = 'Waiver';
  el.classList.toggle('hidden', !active || active === 'closed');
  const i = order.indexOf(active === 'done' ? 'deposit' : active);
  el.querySelectorAll('li').forEach((li, j) => {
    li.classList.toggle('on', j === i && active !== 'done');
    li.classList.toggle('done', j < i || active === 'done');
  });
}

function text(key, dflt) { return S.form?.settings?.texts?.[key] || dflt; }

// ── boot ────────────────────────────────────────────────────────────────────

async function boot() {
  if (!slug) { view.innerHTML = '<h1>Unearthed Education applications</h1><p class="lede">Please use the application link from your school.</p>'; return; }
  if (PREVIEW) return bootPreview();
  const urlToken = params.get('t');
  if (urlToken) {
    store.set(urlToken);
    const rest = new URLSearchParams(location.search); rest.delete('t');
    history.replaceState(null, '', `${BASE}${rest.toString() ? `?${rest}` : ''}`);
  }
  S.token = urlToken || store.get();
  try {
    if (S.token) {
      try {
        const r = await api('GET', null, `?token=${encodeURIComponent(S.token)}`);
        Object.assign(S, { trip: r.trip, form: r.form, app: r.app });
      } catch (e) {
        if (e.status !== 401) throw e;
        store.clear(); S.token = null;
        notice('warn', 'That link has expired. Enter your email below and we\'ll send you a new one, or start again.');
      }
    }
    if (!S.form) {
      const r = await api('GET', null, `?trip=${encodeURIComponent(slug)}${TEACHER ? '&kind=teacher' : ''}`);
      Object.assign(S, { trip: r.trip, form: r.form, prefill: r.prefill || {} });
    }
  } catch (e) {
    view.innerHTML = `<h1>We couldn't open this application</h1><p class="lede">${esc(e.message)}</p>`;
    return;
  }
  header();
  if (params.get('session_id') && !S.token) {
    // A parent paid from their signing link on this device — no student token here.
    view.innerHTML = '<div class="loading">Confirming the payment…</div>';
    try {
      const r = await api('POST', { action: 'confirm', sessionId: params.get('session_id') });
      steps('done');
      view.innerHTML = r.payment.status === 'paid'
        ? `<h1>Deposit received</h1><p class="lede">Thank you — the place on <strong>${esc(S.trip.name)}</strong> is confirmed. We've emailed a confirmation.</p>`
        : `<h1>Payment processing</h1><p class="lede">Thank you — a bank payment can take a few working days to clear. We'll email when it does.</p>`;
    } catch (e) { view.innerHTML = `<h1>Payment</h1><p class="lede">${esc(e.message)}</p>`; }
    history.replaceState(null, '', BASE);
    return;
  }
  if (params.get('session_id') && S.token) {
    view.innerHTML = '<div class="loading">Confirming your payment…</div>';
    try { const r = await api('POST', { action: 'confirm', token: S.token, sessionId: params.get('session_id') }); S.app = r.app; } catch (e) { notice('bad', esc(e.message)); }
    history.replaceState(null, '', BASE);
  } else if (params.get('cancelled')) {
    notice('warn', 'The payment was cancelled — nothing was charged. You can try again below.');
    history.replaceState(null, '', BASE);
  }
  go();
}

function go() {
  const step = S.app?.step || 'about';
  if (!S.app && !S.trip.open && !PREVIEW) return closed();
  steps(step);
  ({ about, application, waiver, waiting, deposit, done })[step]();
  window.scrollTo({ top: 0 });
}

function closed() {
  steps('closed');
  view.innerHTML = `<h1>${S.trip.closedReason === 'full' ? 'This trip is full' : 'Applications are closed'}</h1>
    <p class="lede">Applications for <strong>${esc(S.trip.name)}</strong> aren't open right now. If you think this is a mistake, please contact Unearthed or your school.</p>
    ${resumeBox()}`;
  wireResume();
}

// ── 1. about you ────────────────────────────────────────────────────────────

function about() {
  const step = K.getStep(S.form, 'step1');
  view.innerHTML = `<h1>${esc(step?.title || 'About you')}</h1>
    <p class="lede">${esc(step?.intro || text('aboutIntro', TEACHER ? `${ROLE} application for ${S.trip.name}. It takes about 15 minutes — you can leave and come back with the link we email you.` : `Apply for ${S.trip.name}. It takes about 20 minutes — you can leave and come back with the link we email you.`))}</p>
    <div id="form"></div>
    <div class="actions"><button class="btn btn--primary btn--lg" id="next">${esc(step?.submitLabel || 'Continue')}</button></div>
    ${resumeBox()}`;
  const form = S.form1 = K.renderStep($('#form'), S.form, 'step1', { values: { ...S.prefill, ...(S.app?.answers || {}) } });
  wireResume();
  $('#next').addEventListener('click', async (e) => {
    const form = S.form1; // "Fill test answers" re-renders it
    const v = form.validate();
    if (!v.ok) { form.focusFirstError(); return; }
    busy(e.currentTarget, 'Saving…', async () => {
      try {
        const r = await api('POST', { action: 'start', trip: slug, kind: KIND, ...(TEACHER ? { role: ROLE } : {}), values: form.values(), attribution: attribution() });
        if (r.emailed) {
          view.innerHTML = `<h1>Check your inbox</h1><p class="lede">You've already started an application for this trip with <strong>${esc(form.values().email)}</strong>. We've emailed you a link to carry on where you left off.</p><p class="muted">Can't find it? Check your spam folder, or contact us.</p>`;
          return;
        }
        S.token = r.token; if (!PREVIEW) store.set(r.token); S.app = r.app; notice('', ''); go();
      } catch (err) { fail(err, form); }
    });
  });
}

function resumeBox() {
  return `<details class="resume" style="margin-top:22px"><summary class="muted" style="cursor:pointer">Already started? Get a link to continue</summary>
    <div style="margin-top:12px"><label class="field"><span>${TEACHER ? 'Your email' : 'The student\'s email'}</span><input id="resumeEmail" type="email" autocomplete="email"></label>
    <button class="btn" id="resumeBtn">Email me a link</button></div></details>`;
}
function wireResume() {
  $('#resumeBtn')?.addEventListener('click', (e) => busy(e.currentTarget, 'Sending…', async () => {
    try {
      await api('POST', { action: 'resume', trip: slug, kind: KIND, email: $('#resumeEmail').value });
      notice('ok', 'If there\'s an application for that email, a link to continue is on its way.');
    } catch (err) { notice('bad', esc(err.message)); }
  }));
}

function attribution() {
  const out = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid']) if (params.get(k)) out[k] = params.get(k);
  out.landing = location.href.split('#')[0];
  if (document.referrer) out.referrer = document.referrer;
  return out;
}

// ── 2. application ──────────────────────────────────────────────────────────

let saveTimer = null;
function application() {
  const step = K.getStep(S.form, 'step2');
  view.innerHTML = `<h1>${esc(step?.title || 'Your application')}</h1>
    <p class="lede">${esc(step?.intro || text('applicationIntro', TEACHER ? 'Your answers save as you go. Medical and passport details go only to the Unearthed team and the trip\'s leaders.' : 'Your answers save as you go. Medical and passport details go only to the Unearthed team and your trip leaders.'))}</p>
    <div id="form"></div>
    <div class="actions"><button class="btn btn--primary btn--lg" id="submit">${esc(step?.submitLabel || 'Submit application')}</button><span class="saved" id="saved"></span></div>`;
  const form = S.form2 = K.renderStep($('#form'), S.form, 'step2', {
    values: S.app.answers || {},
    upload: uploadFile,
    onChange: (values) => {
      clearTimeout(saveTimer);
      $('#saved').textContent = '';
      saveTimer = setTimeout(async () => {
        try { await api('POST', { action: 'save', token: S.token, values }); $('#saved').textContent = 'Saved'; }
        catch { $('#saved').textContent = 'Not saved — check your connection'; }
      }, 1500);
    },
  });
  $('#submit').addEventListener('click', async (e) => {
    if (form.busy()) { notice('warn', 'Please wait for your upload to finish.'); return; }
    const v = form.validate();
    if (!v.ok) { notice('bad', 'Some answers need another look — they\'re highlighted below.'); form.focusFirstError(); return; }
    clearTimeout(saveTimer);
    busy(e.currentTarget, 'Submitting…', async () => {
      try {
        const r = await api('POST', { action: 'submit', token: S.token, values: form.values() });
        S.app = r.app; notice('ok', 'Application received — thank you.'); go();
      } catch (err) { fail(err, form); }
    });
  });
}

async function uploadFile(file, field) {
  if (PREVIEW) return { id: 'preview', name: file.name, size: file.size, type: file.type };
  const fd = new FormData();
  fd.append('token', S.token); fd.append('field', field.key); fd.append('file', file);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed — please try again.');
  return data;
}

// ── 3. permissions packet ───────────────────────────────────────────────────

function waiver() {
  S.waiverUi = null;
  const a = S.app.answers || {};
  if (TEACHER || S.app.kind === 'teacher') return teacherWaiver(a);
  const p1 = a.parent1Name;
  const parentName = p1 && typeof p1 === 'object' ? `${p1.first || ''} ${p1.last || ''}`.trim() : String(p1 || '');
  view.innerHTML = `<h1>${esc(S.form.waiver?.title || 'Permissions packet')}</h1>
    <p class="lede">${esc(text('waiverIntro', 'A parent or legal guardian must read and sign this before the deposit can be paid.'))}</p>
    <div class="choice-cards" role="group" aria-label="Who is signing">
      <button class="choice-card" data-mode="here" aria-pressed="false"><strong>My parent/guardian is here</strong><span>Hand them this device — they read and sign now (about 10 minutes).</span></button>
      <button class="choice-card" data-mode="email" aria-pressed="false"><strong>Email it to them</strong><span>They sign from their own phone or computer, then pay the deposit from the same link.</span></button>
    </div>
    <div id="mode"></div>`;
  view.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    view.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    const box = $('#mode');
    if (b.dataset.mode === 'email') {
      box.innerHTML = `<label class="field"><span>Parent or guardian's email</span><input id="pEmail" type="email" autocomplete="off" value="${esc(S.app.waiver?.sentTo || a.parent1Email || '')}"></label>
        <div class="fk-error" id="pEmailErr" role="alert"></div>
        <div class="actions"><button class="btn btn--primary btn--lg" id="sendW">Send the signing link</button></div>`;
      $('#sendW').addEventListener('click', (e) => busy(e.currentTarget, 'Sending…', async () => {
        try {
          const r = await api('POST', { action: 'send-waiver', token: S.token, email: $('#pEmail').value });
          S.app = r.app;
          notice(r.emailed ? '' : 'warn', r.emailed ? '' : 'Saved — but the email couldn\'t be sent just now. Unearthed will follow up.');
          go();
        } catch (err) { $('#pEmailErr').textContent = err.fields?.email || err.message; }
      }));
    } else {
      S.waiverUi = renderWaiver(box, S.form.waiver, {
        under18: S.app.under18, parentName,
        onSubmit: async (input, showErrors) => {
          try {
            const r = await api('POST', { action: 'sign', token: S.token, input });
            S.app = r.app; notice('ok', 'Signed — thank you. A copy has been emailed to the parent/guardian.'); go();
          } catch (err) { if (err.fields) showErrors(err.fields); else notice('bad', esc(err.message)); }
        },
      });
    }
  }));
}

/** Teachers read and sign it themselves — no parent, no emailed link. */
function teacherWaiver(a) {
  const n = a.name;
  const name = n && typeof n === 'object' ? `${n.first || ''} ${n.last || ''}`.trim() : String(n || '');
  view.innerHTML = `<h1>${esc(S.form.waiver?.title || 'Waiver')}</h1>
    <p class="lede">${esc(text('waiverIntro', 'Please read each part, add your initials, and sign at the bottom.'))}</p>
    <div id="mode"></div>`;
  S.waiverUi = renderWaiver($('#mode'), S.form.waiver, {
    under18: false, self: true, parentName: name, submitLabel: 'Sign',
    onSubmit: async (input, showErrors) => {
      try {
        const r = await api('POST', { action: 'sign', token: S.token, input });
        S.app = r.app; notice('ok', 'Signed — thank you. We\'ve emailed you a copy.'); go();
      } catch (err) { if (err.fields) showErrors(err.fields); else notice('bad', esc(err.message)); }
    },
  });
}

// ── waiting for the parent ─────────────────────────────────────────────────

function waiting() {
  const to = S.app.waiver?.sentTo || '';
  view.innerHTML = `<h1>Waiting for your parent or guardian</h1>
    <p class="lede">We've emailed the permissions packet to <strong>${esc(to)}</strong>. Once they've signed it, they can pay the deposit straight from that link — or you can come back here to pay.</p>
    <p class="muted">Can't find the email? Check spam, or send it again (to them or to another parent or guardian).</p>
    <div class="actions"><button class="btn btn--primary" id="check">They've signed — continue</button><button class="btn" id="again">Send it again</button><button class="btn btn--ghost" id="here">They're with me now</button></div>`;
  $('#check').addEventListener('click', (e) => busy(e.currentTarget, 'Checking…', async () => {
    if (PREVIEW) { S.app = previewState('deposit', {}, { status: 'signed' }); go(); return; }
    const r = await api('GET', null, `?token=${encodeURIComponent(S.token)}`);
    S.app = r.app;
    if (S.app.step === 'waiting') notice('warn', 'Not signed yet — we\'ll keep the link open.'); else { notice('', ''); go(); }
  }));
  $('#again').addEventListener('click', () => { S.app = { ...S.app, step: 'waiver' }; waiver(); $('[data-mode=email]').click(); });
  $('#here').addEventListener('click', () => { waiver(); $('[data-mode=here]').click(); });
}

// ── 4. deposit ──────────────────────────────────────────────────────────────

function deposit() {
  renderDeposit(view, {
    trip: S.trip, cardFeeRate: S.form.settings?.cardFeeRate ?? 0.03, intro: text('depositIntro', ''),
    processing: S.app.deposit?.status === 'processing',
    onPay: async (method) => {
      if (PREVIEW) {
        notice('ok', `<strong>Preview:</strong> here the family goes to Stripe to pay by ${method === 'bank' ? 'NZ bank account' : 'card'} and comes back to the confirmation. <button class="btn btn--sm" id="pvPaid">Show the confirmation</button>`);
        $('#pvPaid').addEventListener('click', () => { S.app = previewState('done', {}, null, { status: 'paid' }); notice('', ''); go(); });
        return;
      }
      const r = await api('POST', { action: 'checkout', token: S.token, method });
      if (r.url) location.assign(r.url); else { S.app = r.app; go(); }
    },
  });
}

// ── done ────────────────────────────────────────────────────────────────────

function done() {
  if (TEACHER || S.app.kind === 'teacher') {
    view.innerHTML = `<h1>Application complete</h1>
      <p class="lede">Thank you — your ${esc(ROLE_LC)} application for <strong>${esc(S.trip.name)}</strong> is complete and your waiver is signed. We've emailed you a copy.</p>
      <p>${esc(text('doneNext', 'The Unearthed team will be in touch, and will give you access to the trip in the leader portal.'))}</p>`;
    return;
  }
  const paid = S.app.deposit?.status === 'paid';
  view.innerHTML = `<h1>${paid ? 'You\'re in!' : 'Application complete'}</h1>
    <p class="lede">${paid ? `Your deposit is paid and your place on <strong>${esc(S.trip.name)}</strong> is confirmed.` : `Your application for <strong>${esc(S.trip.name)}</strong> is complete and the permissions packet is signed.`} We've emailed a confirmation.</p>
    <p>${esc(text('doneNext', 'Next: log in to your Unearthed portal for your itinerary, packing list and payment schedule.'))}</p>`;
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function busy(btn, label, fn) {
  const old = btn.textContent; btn.disabled = true; btn.textContent = label;
  try { await fn(); } finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = old; } }
}

function fail(err, form) {
  if (err.status === 401) { store.clear(); notice('bad', esc(err.message)); return; }
  if (err.fields && form) { form.setErrors(err.fields); form.focusFirstError(); }
  notice('bad', esc(err.message));
}

// ── testing: preview mode + "Fill test answers" ────────────────────────────

function previewState(step, answers = {}, waiver = undefined, deposit = null) {
  return {
    kind: KIND,
    status: step === 'done' ? 'paid' : 'applied', step,
    answers: { ...(S.app?.answers || {}), ...answers },
    waiver: waiver === undefined ? S.app?.waiver || null : waiver,
    deposit: deposit || (step === 'done' ? { status: 'paid' } : null),
    under18: !TEACHER,
  };
}

async function bootPreview() {
  try {
    const r = await fetch(`/api/apply?trip=${encodeURIComponent(slug)}${TEACHER ? '&kind=teacher' : ''}`).then(async (x) => { const d = await x.json(); if (!x.ok) throw new Error(d.error); return d; });
    Object.assign(S, { trip: r.trip, form: r.form, prefill: r.prefill || {}, token: 'preview' });
  } catch (e) { view.innerHTML = `<h1>Preview</h1><p class="lede">${esc(e.message)}</p>`; return; }
  header();
  go();
}

function testBar() {
  const bar = document.createElement('div');
  bar.className = `pvbar${PREVIEW ? '' : ' test'}`;
  bar.innerHTML = PREVIEW
    ? `<span><strong>Preview</strong> — nothing is saved or sent.</span>
       <span class="jump">Jump to: ${(TEACHER ? [['about', 'About you'], ['application', 'Application'], ['waiver', 'Waiver'], ['done', 'Done']] : [['about', 'About you'], ['application', 'Application'], ['waiver', 'Permissions'], ['waiting', 'Waiting for parent'], ['deposit', 'Deposit'], ['done', 'Done']]).map(([k, l]) => `<button data-jump="${k}">${l}</button>`).join('')}</span>
       <button class="fill" id="tFill">Fill test answers</button>`
    : `<span><strong>Test run</strong> — this is a REAL application (HubSpot, Jotform, emails, Stripe).</span>
       <button class="fill" id="tFill">Fill test answers</button><span style="opacity:.85">Emails are left for you to type, so the messages reach you.</span>`;
  document.body.prepend(bar);
  bar.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.jump;
    const all = { ...sampleValues(S.form, 'step1'), ...sampleValues(S.form, 'step2') };
    S.app = k === 'about' ? null : previewState(k, all, k === 'waiting' ? { status: 'sent', sentTo: 'preview.parent1email@example.com' } : ['deposit', 'done'].includes(k) ? { status: 'signed' } : null);
    notice('', ''); go();
  }));
  bar.querySelector('#tFill').addEventListener('click', fillTest);
}

async function fillTest() {
  const step = S.app?.step || 'about';
  const keepEmails = !PREVIEW;
  if (step === 'about' && S.form1) {
    const cur = S.form1.values();
    const vals = { ...cur, ...sampleValues(S.form, 'step1', { keepEmails, current: cur }) };
    S.form1 = K.renderStep($('#form'), S.form, 'step1', { values: vals });
    if (keepEmails && !vals.email) notice('warn', `Filled — type ${TEACHER ? 'your' : 'the student\'s'} email (use one you can check), then Continue.`);
    return;
  }
  if (step === 'application' && S.form2) {
    const cur = S.form2.values();
    const vals = { ...cur, ...sampleValues(S.form, 'step2', { keepEmails, current: cur }) };
    // Upload questions: a small test image (a fake one in preview).
    for (const { field } of K.allFields(S.form)) {
      if (field.type !== 'file' || field.hidden || !K.isVisible(S.form, field, vals)) continue;
      if (Array.isArray(vals[field.key]) && vals[field.key].length) continue;
      try {
        vals[field.key] = [PREVIEW ? { id: 'preview', name: 'test-upload.png', size: 1, type: 'image/png' } : await uploadFile(await testImageFile(), field)];
      } catch (e) { notice('bad', `Couldn't upload the test image: ${esc(e.message)}`); }
    }
    S.app = { ...S.app, answers: { ...(S.app.answers || {}), ...vals } };
    application();
    if (keepEmails && !TEACHER && !vals.parent1Email) notice('warn', 'Filled — type the parent/guardian email (use one you can check), then Submit.');
    return;
  }
  if (step === 'waiver') {
    if (!S.waiverUi) { $('[data-mode=here]')?.click(); }
    const p1 = TEACHER ? S.app?.answers?.name : S.app?.answers?.parent1Name;
    S.waiverUi?.fillTest(p1 && typeof p1 === 'object' ? `${p1.first} ${p1.last}` : String(p1 || (TEACHER ? `Test ${ROLE}` : 'Test Parent')));
    $('#wvSubmit')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  notice('ok', 'Nothing to fill on this step.');
}

if (TESTING) testBar();
boot();
