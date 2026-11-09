// The Unearthed application flow: apply.unearthededucation.org/<trip-slug>
// About you → Application → Permissions packet → Deposit.
// The server holds everything; the browser keeps only a resume token per trip.
import * as K from './form-kit.mjs';
import { renderWaiver, WAIVER_CSS } from './waiver-ui.mjs';

const $ = (s, r = document) => r.querySelector(s);
const esc = K.esc;
const view = $('#view');
const style = document.createElement('style');
style.textContent = K.FORM_CSS + WAIVER_CSS;
document.head.appendChild(style);

const slug = decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || '').toLowerCase();
const params = new URLSearchParams(location.search);
const TOKEN_KEY = `ue-apply:${slug}`;
const S = { trip: null, form: null, app: null, token: null, prefill: {} };

const store = {
  get() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode: token lives for this page only */ } },
  clear() { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

async function api(method, body, qs = '') {
  const res = await fetch(`/api/apply${qs}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Something went wrong (${res.status}).`), { status: res.status, fields: data?.fields });
  return data;
}

function notice(kind, html) {
  $('#notice').innerHTML = html ? `<div class="notice ${kind}" role="status">${html}</div>` : '';
  if (html) $('#notice').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function money(n, cur) {
  try { return new Intl.NumberFormat('en-NZ', { style: 'currency', currency: cur || 'NZD', currencyDisplay: 'code' }).format(n); }
  catch { return `${cur} ${Number(n).toFixed(2)}`; }
}

function header() {
  const t = S.trip;
  $('#tripHead').innerHTML = t ? `<strong>${esc(t.destination || t.name)}</strong>${esc(t.school || '')}` : '';
  document.title = t ? `Apply — ${t.name} — Unearthed Education` : 'Apply — Unearthed Education';
}

function steps(active) {
  const order = ['about', 'application', 'waiver', 'deposit'];
  const el = $('#steps');
  if (S.trip?.schoolCollecting) el.querySelector('[data-s=deposit]').classList.add('hidden');
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
  const urlToken = params.get('t');
  if (urlToken) {
    store.set(urlToken);
    const rest = new URLSearchParams(location.search); rest.delete('t');
    history.replaceState(null, '', `/${slug}${rest.toString() ? `?${rest}` : ''}`);
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
      const r = await api('GET', null, `?trip=${encodeURIComponent(slug)}`);
      Object.assign(S, { trip: r.trip, form: r.form, prefill: r.prefill || {} });
    }
  } catch (e) {
    view.innerHTML = `<h1>We couldn't open this application</h1><p class="lede">${esc(e.message)}</p>`;
    return;
  }
  header();
  if (params.get('session_id') && S.token) {
    view.innerHTML = '<div class="loading">Confirming your payment…</div>';
    try { const r = await api('POST', { action: 'confirm', token: S.token, sessionId: params.get('session_id') }); S.app = r.app; } catch (e) { notice('bad', esc(e.message)); }
    history.replaceState(null, '', `/${slug}`);
  } else if (params.get('cancelled')) {
    notice('warn', 'The payment was cancelled — nothing was charged. You can try again below.');
    history.replaceState(null, '', `/${slug}`);
  }
  go();
}

function go() {
  const step = S.app?.step || 'about';
  if (!S.app && !S.trip.open) return closed();
  steps(step);
  ({ about, application, waiver, deposit, done })[step]();
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
    <p class="lede">${esc(step?.intro || text('aboutIntro', `Apply for ${S.trip.name}. It takes about 20 minutes — you can leave and come back with the link we email you.`))}</p>
    <div id="form"></div>
    <div class="actions"><button class="btn btn--primary btn--lg" id="next">${esc(step?.submitLabel || 'Continue')}</button></div>
    ${resumeBox()}`;
  const form = K.renderStep($('#form'), S.form, 'step1', { values: { ...S.prefill, ...(S.app?.answers || {}) } });
  wireResume();
  $('#next').addEventListener('click', async (e) => {
    const v = form.validate();
    if (!v.ok) { form.focusFirstError(); return; }
    busy(e.currentTarget, 'Saving…', async () => {
      try {
        const r = await api('POST', { action: 'start', trip: slug, values: form.values(), attribution: attribution() });
        if (r.emailed) {
          view.innerHTML = `<h1>Check your inbox</h1><p class="lede">You've already started an application for this trip with <strong>${esc(form.values().email)}</strong>. We've emailed you a link to carry on where you left off.</p><p class="muted">Can't find it? Check your spam folder, or contact us.</p>`;
          return;
        }
        S.token = r.token; store.set(r.token); S.app = r.app; notice('', ''); go();
      } catch (err) { fail(err, form); }
    });
  });
}

function resumeBox() {
  return `<details class="resume" style="margin-top:22px"><summary class="muted" style="cursor:pointer">Already started? Get a link to continue</summary>
    <div style="margin-top:12px"><label class="field"><span>The student's email</span><input id="resumeEmail" type="email" autocomplete="email"></label>
    <button class="btn" id="resumeBtn">Email me a link</button></div></details>`;
}
function wireResume() {
  $('#resumeBtn')?.addEventListener('click', (e) => busy(e.currentTarget, 'Sending…', async () => {
    try {
      await api('POST', { action: 'resume', trip: slug, email: $('#resumeEmail').value });
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
    <p class="lede">${esc(step?.intro || text('applicationIntro', 'Your answers save as you go. Medical and passport details go only to the Unearthed team and your trip leaders.'))}</p>
    <div id="form"></div>
    <div class="actions"><button class="btn btn--primary btn--lg" id="submit">${esc(step?.submitLabel || 'Submit application')}</button><span class="saved" id="saved"></span></div>`;
  const form = K.renderStep($('#form'), S.form, 'step2', {
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
  const fd = new FormData();
  fd.append('token', S.token); fd.append('field', field.key); fd.append('file', file);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed — please try again.');
  return data;
}

// ── 3. permissions packet ───────────────────────────────────────────────────

function waiver() {
  const a = S.app.answers || {};
  const p1 = a.parent1Name;
  const parentName = p1 && typeof p1 === 'object' ? `${p1.first || ''} ${p1.last || ''}`.trim() : String(p1 || '');
  view.innerHTML = `<h1>${esc(S.form.waiver?.title || 'Permissions packet')}</h1>
    <p class="lede">${esc(text('waiverIntro', 'A parent or legal guardian needs to read and sign this before the trip — whatever the student\'s age.'))}</p>
    <div class="choice-cards" role="group" aria-label="Who is signing">
      <button class="choice-card" data-mode="here" aria-pressed="false"><strong>My parent/guardian is here</strong><span>They read and sign now, on this device (about 10 minutes).</span></button>
      <button class="choice-card" data-mode="email" aria-pressed="false"><strong>Email it to them</strong><span>We send them a link to sign. You can carry on to the deposit meanwhile.</span></button>
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
          notice(r.emailed ? 'ok' : 'warn', r.emailed ? `We've emailed the signing link to <strong>${esc($('#pEmail').value)}</strong>.` : 'Saved — but the email couldn\'t be sent just now. Unearthed will follow up.');
          go();
        } catch (err) { $('#pEmailErr').textContent = err.fields?.email || err.message; }
      }));
    } else {
      renderWaiver(box, S.form.waiver, {
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

// ── 4. deposit ──────────────────────────────────────────────────────────────

function deposit() {
  const t = S.trip;
  const rate = Number(S.form.settings?.cardFeeRate ?? 0.03);
  const card = Math.round(t.deposit * (1 + rate) * 100) / 100;
  const bank = t.currency === 'NZD';
  const processing = S.app.deposit?.status === 'processing';
  const unsigned = S.app.waiver?.status === 'sent';
  if (t.deposit == null) {
    view.innerHTML = `<h1>Deposit</h1><p class="lede">The deposit for this trip isn't set up yet — the Unearthed team has been told and will be in touch. Your application is saved.</p>`;
    return;
  }
  view.innerHTML = `<h1>Pay your deposit</h1>
    <p class="lede">${esc(text('depositIntro', 'Your deposit confirms your place. It counts toward the full trip cost; the rest of your payments are in your Unearthed portal.'))}</p>
    ${unsigned ? `<div class="notice warn">The permissions packet is waiting for your parent/guardian to sign (sent to ${esc(S.app.waiver.sentTo)}). You can pay the deposit now.</div>` : ''}
    ${processing ? '<div class="notice warn">Your bank payment is processing — this can take a few working days. We\'ll email you when it clears.</div>' : ''}
    <div class="pay-amount">${money(t.deposit, t.currency)}</div>
    <p class="muted" style="margin:0 0 18px">${esc(t.name)}</p>
    <div class="choice-cards">
      <button class="choice-card" data-pay="card"><strong>Card — ${money(card, t.currency)}</strong><span>Includes the ${(rate * 100).toFixed(rate * 100 % 1 ? 1 : 0)}% card processing fee.</span></button>
      ${bank ? `<button class="choice-card" data-pay="bank"><strong>NZ bank account — ${money(t.deposit, t.currency)}</strong><span>No fee. Takes a few working days to clear.</span></button>` : ''}
    </div>
    <p class="muted" style="font-size:14px">You'll pay on Stripe's secure page and come straight back here.</p>`;
  view.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', (e) => busy(e.currentTarget, 'Opening secure payment…', async () => {
    try {
      const r = await api('POST', { action: 'checkout', token: S.token, method: b.dataset.pay });
      if (r.url) location.assign(r.url); else { S.app = r.app; go(); }
    } catch (err) { notice('bad', esc(err.message)); }
  })));
}

// ── done ────────────────────────────────────────────────────────────────────

function done() {
  const paid = S.app.deposit?.status === 'paid';
  const unsigned = S.app.waiver?.status === 'sent';
  view.innerHTML = `<h1>${paid ? 'You\'re in!' : 'Application complete'}</h1>
    <p class="lede">${paid ? `Your deposit is paid and your place on <strong>${esc(S.trip.name)}</strong> is confirmed.` : `Your application for <strong>${esc(S.trip.name)}</strong> is complete.`} We've emailed a confirmation.</p>
    ${unsigned ? `<div class="notice warn">One thing left: your parent/guardian still needs to sign the permissions packet — we sent the link to ${esc(S.app.waiver.sentTo)}.</div>` : ''}
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

boot();
