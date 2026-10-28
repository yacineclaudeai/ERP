/*
 * Order form for product landing pages.
 *
 *   <div id="erp-order-form"></div>
 *   <script src="https://YOUR-ERP-DOMAIN/embed.js" data-key="PRODUCT_KEY"></script>
 *
 * Optional attributes: data-target="#selector", data-success-url="https://.../merci",
 * data-color="#0f766e". For a fully custom form, call
 * window.ErpOrder.submit({ name, phone, wilaya, commune, address, quantity, stop_desk }).
 */
(function () {
  var script = document.currentScript;
  var base = new URL(script.src).origin;
  var key = script.getAttribute('data-key');
  var target = document.querySelector(script.getAttribute('data-target') || '#erp-order-form');
  var successUrl = script.getAttribute('data-success-url');
  var color = script.getAttribute('data-color') || '#0f766e';
  var params = new URLSearchParams(location.search);

  function submit(data) {
    var body = Object.assign({
      key: key,
      landing_url: location.href,
      utm_source: params.get('utm_source'),
      utm_campaign: params.get('utm_campaign'),
    }, data);
    return fetch(base + '/api/public/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (json) {
        if (!res.ok) throw new Error(json.error || 'Erreur');
        return json;
      });
    });
  }
  window.ErpOrder = { submit: submit };
  if (!target || !key) return;

  var css = '.erpf{font-family:system-ui,sans-serif;direction:rtl;max-width:460px;margin:auto;display:grid;gap:10px}' +
    '.erpf input,.erpf select,.erpf textarea{width:100%;box-sizing:border-box;padding:12px;border:1px solid #cbd5e1;border-radius:10px;font-size:16px;background:#fff}' +
    '.erpf .row{display:flex;gap:8px}.erpf .row>*{flex:1}' +
    '.erpf .opt{display:flex;gap:8px}.erpf .opt label{flex:1;border:1px solid #cbd5e1;border-radius:10px;padding:10px;text-align:center;cursor:pointer}' +
    '.erpf .opt input{width:auto;margin-left:6px}' +
    '.erpf .sum{background:#f1f5f9;border-radius:10px;padding:12px;line-height:1.8}' +
    '.erpf button{padding:14px;border:0;border-radius:10px;color:#fff;font-size:18px;font-weight:700;cursor:pointer;background:' + color + '}' +
    '.erpf .msg{text-align:center;font-weight:600}.erpf .err{color:#b91c1c}.erpf .hp{display:none}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  fetch(base + '/api/public/products/' + encodeURIComponent(key)).then(function (r) { return r.json(); }).then(function (p) {
    if (!p.wilayas) { target.textContent = p.error || ''; return; }
    var opts = p.wilayas.map(function (w) {
      return '<option value="' + w.code + '">' + w.code + ' - ' + w.name_ar + ' / ' + w.name_fr + '</option>';
    }).join('');
    target.innerHTML =
      '<form class="erpf">' +
      '<input name="name" placeholder="الاسم و اللقب" required>' +
      '<input name="phone" type="tel" inputmode="tel" placeholder="رقم الهاتف" required>' +
      '<select name="wilaya" required><option value="">اختر الولاية</option>' + opts + '</select>' +
      '<div class="row"><input name="commune" placeholder="البلدية"><input name="quantity" type="number" min="1" value="1"></div>' +
      '<input name="address" placeholder="العنوان">' +
      '<div class="opt"><label><input type="radio" name="stop_desk" value="0" checked>توصيل للمنزل</label>' +
      '<label><input type="radio" name="stop_desk" value="1">استلام من المكتب</label></div>' +
      '<input class="hp" name="website" tabindex="-1" autocomplete="off">' +
      '<div class="sum"></div><button type="submit">اطلب الآن - الدفع عند الاستلام</button><div class="msg"></div></form>';
    var form = target.querySelector('form');
    var sum = form.querySelector('.sum');
    var msg = form.querySelector('.msg');
    function refresh() {
      var w = p.wilayas.find(function (x) { return String(x.code) === form.wilaya.value; });
      var qty = Math.max(1, parseInt(form.quantity.value, 10) || 1);
      var desk = form.querySelector('[name=stop_desk]:checked').value === '1';
      var fee = w ? (desk ? w.desk_fee : w.home_fee) : 0;
      sum.innerHTML = p.name + ': ' + (p.price * qty).toLocaleString() + ' دج<br>التوصيل: ' +
        (w ? fee.toLocaleString() + ' دج' : '—') + '<br><b>المجموع: ' + (p.price * qty + fee).toLocaleString() + ' دج</b>';
    }
    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    refresh();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = form.querySelector('button');
      btn.disabled = true;
      msg.className = 'msg';
      msg.textContent = '...';
      var data = Object.fromEntries(new FormData(form).entries());
      submit(data).then(function (res) {
        if (window.fbq) window.fbq('track', 'Purchase', { value: res.total, currency: 'DZD' });
        if (successUrl) { location.href = successUrl; return; }
        form.innerHTML = '<div class="msg">✅ شكراً! تم تسجيل طلبك، سنتصل بك قريباً لتأكيده.</div>';
      }).catch(function (err) {
        btn.disabled = false;
        msg.className = 'msg err';
        msg.textContent = err.message;
      });
    });
  });
})();
