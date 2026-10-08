/*!
 * checkout.js v1 — open a hosted checkout in a secure popup window (docs/CHECKOUT.md §7).
 *
 *   <script src="https://<your-pay-domain>/js/v1/checkout.js"></script>
 *   button.onclick = () => Pay2All.checkout({
 *     // The session url from POST /v1/checkout/sessions (your server): a string, or a function /
 *     // promise returning it — the window opens at once and loads the url when it arrives.
 *     url: () => fetch('/api/checkout', { method: 'POST' }).then((r) => r.json()).then((s) => s.url),
 *     onSuccess: (r) => verifyOnServer(r.checkout_session_id),
 *     onFailure: (r) => {},                  // EXPIRED or CANCELLED
 *     onClose: () => verifyOnServer(id),     // closed without a result: check, it may be paid
 *   });
 *
 * Call it directly in a click handler so browsers allow the popup; if a popup is blocked the
 * customer is sent to the checkout page instead (classic redirect). Results are posted only to your
 * approved website's origin and are hints for the UI — always confirm on your server.
 */
(function () {
  'use strict';
  if (window.Pay2All && window.Pay2All.version) return;

  var script = document.currentScript;
  var ORIGIN = script ? new URL(script.src).origin : window.location.origin;
  var active = null;

  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text) e.textContent = text;
    return e;
  }

  function overlay(onFocus, onCancel) {
    var root = el('div', 'position:fixed;inset:0;z-index:2147483646;background:rgba(15,23,42,.62);display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:16px');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Secure payment in progress');
    var card = el('div', 'background:#fff;color:#0f172a;border-radius:16px;max-width:360px;width:100%;padding:24px;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.3)');
    card.appendChild(el('div', 'width:40px;height:40px;margin:0 auto 12px;border:3px solid #cbd5e1;border-top-color:#2563eb;border-radius:50%;animation:p2a-spin 1s linear infinite'));
    card.appendChild(el('p', 'margin:0 0 4px;font-size:17px;font-weight:600', 'Complete your payment'));
    card.appendChild(el('p', 'margin:0 0 16px;font-size:14px;color:#475569', 'A secure payment window is open. Finish paying there — this page updates by itself.'));
    var show = el('button', 'display:block;width:100%;padding:10px 14px;border-radius:10px;border:0;background:#2563eb;color:#fff;font-size:14px;font-weight:600;cursor:pointer', 'Show payment window');
    show.type = 'button';
    show.onclick = onFocus;
    var cancel = el('button', 'display:block;width:100%;margin-top:8px;padding:10px 14px;border-radius:10px;border:1px solid #cbd5e1;background:#fff;color:#334155;font-size:14px;cursor:pointer', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = onCancel;
    card.appendChild(show);
    card.appendChild(cancel);
    root.appendChild(card);
    var style = el('style');
    style.textContent = '@keyframes p2a-spin{to{transform:rotate(360deg)}}';
    root.appendChild(style);
    document.body.appendChild(root);
    show.focus();
    return root;
  }

  function checkoutUrl(url) {
    var target = new URL(String(url), ORIGIN);
    if (target.origin !== ORIGIN || target.pathname.indexOf('/checkout/') !== 0) throw new Error('Pay2All.checkout: url must be a checkout URL from ' + ORIGIN);
    return target;
  }

  function checkout(opts) {
    if (!opts || !opts.url) throw new Error('Pay2All.checkout: pass { url } — the checkout session url, or a function/promise returning it');
    if (active) {
      active.win.focus();
      return;
    }
    var pending = typeof opts.url === 'function' ? Promise.resolve().then(opts.url) : Promise.resolve(opts.url);
    var w = 480;
    var h = 760;
    var left = Math.max(0, (window.screenX || 0) + ((window.outerWidth || w) - w) / 2);
    var top = Math.max(0, (window.screenY || 0) + ((window.outerHeight || h) - h) / 2);
    // Opened synchronously (inside the click) so it isn't blocked; the url loads when it arrives.
    var win = window.open('', 'pay2all_checkout', 'popup=yes,width=' + w + ',height=' + h + ',left=' + left + ',top=' + top);
    if (!win) {
      // Popup blocked: classic redirect (the customer returns to your return_url).
      pending.then(function (url) {
        window.location.assign(checkoutUrl(url).toString());
      });
      return;
    }
    try {
      win.document.title = 'Secure payment';
      win.document.body.style.cssText = 'margin:0;display:grid;place-items:center;min-height:100vh;font-family:system-ui,sans-serif;color:#475569';
      win.document.body.textContent = 'Opening secure payment…';
    } catch (_) {}
    pending.then(
      function (url) {
        var target = checkoutUrl(url);
        target.searchParams.set('embed', 'popup');
        if (!win.closed) win.location.replace(target.toString());
      },
      function (err) {
        try {
          win.close();
        } catch (_) {}
        finish(opts.onError || opts.onClose, err);
      },
    );
    var done = false;
    function finish(cb, result) {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMessage);
      clearInterval(timer);
      if (ui && ui.parentNode) ui.parentNode.removeChild(ui);
      active = null;
      if (typeof cb === 'function') cb(result);
    }
    function onMessage(e) {
      if (e.origin !== ORIGIN || e.source !== win || !e.data || e.data.source !== 'pay2all' || e.data.type !== 'checkout.result') return;
      var r = { status: e.data.status, checkout_session_id: e.data.checkout_session_id, merchant_order_id: e.data.merchant_order_id, payment_id: e.data.payment_id || null };
      finish(r.status === 'PAID' ? opts.onSuccess : opts.onFailure, r);
    }
    window.addEventListener('message', onMessage);
    var timer = setInterval(function () {
      if (win.closed) finish(opts.onClose);
    }, 500);
    var ui = overlay(
      function () {
        win.focus();
      },
      function () {
        try {
          win.close();
        } catch (_) {}
        finish(opts.onClose);
      },
    );
    active = { win: win };
  }

  window.Pay2All = { version: '1.1', checkout: checkout };
})();
