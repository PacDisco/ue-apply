// /sign?t=… — a parent signs the permissions packet from the emailed link.
import { esc, FORM_CSS } from './form-kit.mjs';
import { renderWaiver, WAIVER_CSS } from './waiver-ui.mjs';

const $ = (s) => document.querySelector(s);
const style = document.createElement('style'); style.textContent = FORM_CSS + WAIVER_CSS; document.head.appendChild(style);
const token = new URLSearchParams(location.search).get('t') || '';
const view = $('#view');

async function api(method, body, qs = '') {
  const res = await fetch(`/api/apply${qs}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || `Something went wrong (${res.status}).`), { fields: data?.fields });
  return data;
}

function thanks(name) {
  view.innerHTML = `<h1>Thank you${name ? `, ${esc(name.split(/\s+/)[0])}` : ''}</h1><p class="lede">The permissions packet is signed. A copy has been emailed to you for your records.</p>`;
}

(async () => {
  let info;
  try { info = await api('GET', null, `?sign=${encodeURIComponent(token)}`); }
  catch (e) { view.innerHTML = `<h1>This link doesn't work</h1><p class="lede">${esc(e.message)}</p>`; return; }
  $('#tripHead').innerHTML = `<strong>${esc(info.trip.destination || info.trip.name)}</strong>${esc(info.trip.school || '')}`;
  if (info.signed) { thanks(info.signed.parentName); return; }
  view.innerHTML = `<h1>${esc(info.waiver.title || 'Permissions packet')}</h1>
    <p class="lede"><strong>${esc(info.student)}</strong> has applied for <strong>${esc(info.trip.name)}</strong>. Please read each part, add your initials, then sign at the bottom. It takes about 10 minutes.</p>
    <div id="w"></div>`;
  renderWaiver($('#w'), info.waiver, {
    under18: info.under18, parentName: info.parent || '', submitLabel: 'Sign',
    onSubmit: async (input, showErrors) => {
      try { await api('POST', { action: 'sign', signToken: token, input }); thanks(input.parentName); window.scrollTo({ top: 0 }); }
      catch (e) { if (e.fields) showErrors(e.fields); else $('#notice').innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; }
    },
  });
})();
