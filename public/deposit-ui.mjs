// The deposit step on screen — used by the student's flow and by the parent's
// /sign page (a parent who signs from the emailed link can pay straight away).
import { esc } from './form-kit.mjs';

export function money(n, cur) {
  try { return new Intl.NumberFormat('en-NZ', { style: 'currency', currency: cur || 'NZD', currencyDisplay: 'code' }).format(n); }
  catch { return `${cur} ${Number(n).toFixed(2)}`; }
}

/**
 * @param root    element to render into
 * @param o       { trip, cardFeeRate, intro, processing, onPay: async (method) => void }
 */
export function renderDeposit(root, { trip, cardFeeRate = 0.03, intro = '', processing = false, onPay }) {
  if (trip.deposit == null) {
    root.innerHTML = `<h1>Deposit</h1><p class="lede">The deposit for this trip isn't set up yet — the Unearthed team will be in touch. Everything else is saved.</p>`;
    return;
  }
  const rate = Number(cardFeeRate);
  const card = Math.round(trip.deposit * (1 + rate) * 100) / 100;
  const bank = trip.currency === 'NZD';
  const pct = (rate * 100).toFixed((rate * 100) % 1 ? 1 : 0);
  root.innerHTML = `<h1>Pay the deposit</h1>
    <p class="lede">${esc(intro || 'The deposit confirms the place. It counts toward the full trip cost; the rest of the payments are in the Unearthed portal.')}</p>
    ${processing ? '<div class="notice warn">A bank payment is processing — this can take a few working days. We\'ll email when it clears.</div>' : ''}
    <div class="pay-amount">${money(trip.deposit, trip.currency)}</div>
    <p class="muted" style="margin:0 0 18px">${esc(trip.name)}</p>
    <div class="choice-cards">
      <button class="choice-card" data-pay="card"><strong>Card — ${money(card, trip.currency)}</strong><span>Includes the ${pct}% card processing fee.</span></button>
      ${bank ? `<button class="choice-card" data-pay="bank"><strong>NZ bank account — ${money(trip.deposit, trip.currency)}</strong><span>No fee. Takes a few working days to clear.</span></button>` : ''}
    </div>
    <p class="muted" style="font-size:14px">You'll pay on Stripe's secure page and come straight back here.</p>
    <div id="payErr"></div>`;
  root.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', async () => {
    const label = b.innerHTML; b.disabled = true; b.innerHTML = '<strong>Opening secure payment…</strong>';
    try { await onPay(b.dataset.pay); }
    catch (e) { root.querySelector('#payErr').innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; }
    finally { if (b.isConnected) { b.disabled = false; b.innerHTML = label; } }
  }));
}
