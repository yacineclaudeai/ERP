// Admin interface: a small hash-routed single page app, no build step.

const STATUS_LABELS = {
  new: 'جديدة', no_answer: 'ما ردش', postponed: 'مؤجلة', confirmed: 'مؤكدة', cancelled: 'ملغاة',
  dispatched: 'عند التوصيل', delivered: 'مستلمة', returned: 'روتور',
};
const EVENT_LABELS = {
  created: 'تسجلت', duplicate: 'مكررة؟', no_answer: 'ما ردش', postponed: 'تأجلت', confirmed: 'تأكدت',
  cancelled: 'تلغات', reopened: 'تعاودت تفتحت', dispatched: 'تبعثت للتوصيل', dispatch_failed: 'فشل الإرسال',
  delivered: 'تستلمت', returned: 'روتور', edited: 'تعدلت',
};
const PROVIDER_LABELS = { ecotrack: 'Ecotrack (API)', sandbox: 'تجربة (بدون API)', manual: 'يدوي (بدون API)' };

const state = { user: null, meta: null };
const app = document.getElementById('app');

// ---------- helpers ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => `${Math.round(Number(v) || 0).toLocaleString('fr-DZ')} دج`;
const pct = (v) => (v == null ? '—' : `${v}%`);
const badge = (s) => `<span class="badge ${s}">${STATUS_LABELS[s] || s}</span>`;
const wilaya = (code) => {
  const w = state.meta?.wilayas.find((x) => x.code === Number(code));
  return w ? `${w.code} - ${w.name_ar}` : code;
};
const wilayaOptions = (selected) => state.meta.wilayas
  .map((w) => `<option value="${w.code}" ${Number(selected) === w.code ? 'selected' : ''}>${w.code} - ${w.name_ar} / ${w.name_fr}</option>`).join('');
const today = () => new Date().toISOString().slice(0, 10);

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') {
    state.user = null;
    location.hash = '#/login';
    throw new Error(data.error || 'غير مسجل');
  }
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast${isError ? ' err' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), 3500);
}

const modal = {
  open(html) {
    document.getElementById('modal-box').innerHTML = html;
    document.getElementById('modal').classList.remove('hidden');
    return document.getElementById('modal-box');
  },
  close() {
    document.getElementById('modal').classList.add('hidden');
  },
};
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal' || e.target.closest('[data-close]')) modal.close();
});

const formData = (form) => Object.fromEntries(new FormData(form).entries());

// Runs an async handler and reports errors as a toast.
const guard = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    toast(err.message, true);
  }
};

// ---------- layout & routing ----------
const NAV = [
  ['#/', 'لوحة التحكم'],
  ['#/orders', 'الطلبيات'],
  ['#/products', 'المنتجات'],
  ['#/stores', 'البوتيكات', 'admin'],
  ['#/delivery', 'التوصيل', 'admin'],
  ['#/ads', 'مصاريف الإشهار', 'admin'],
  ['#/users', 'المستخدمين', 'admin'],
];

function shell(content) {
  const route = location.hash.split('?')[0] || '#/';
  app.innerHTML = `
    <div class="layout">
      <nav class="side">
        <h1>ERP</h1>
        ${NAV.filter(([, , role]) => !role || state.user.role === role)
          .map(([href, label]) => `<a href="${href}" class="${route === href ? 'active' : ''}">${label}</a>`).join('')}
        <a href="#" id="logout">خروج</a>
        <div class="who">${esc(state.user.username)} · ${state.user.role === 'admin' ? 'مدير' : 'مؤكدة'}</div>
      </nav>
      <main class="main" id="main">${content}</main>
    </div>`;
  document.getElementById('logout').onclick = guard(async (e) => {
    e.preventDefault();
    await api('POST', '/auth/logout');
    state.user = null;
    location.hash = '#/login';
  });
  return document.getElementById('main');
}

const ROUTES = {
  '#/': dashboardPage,
  '#/orders': ordersPage,
  '#/products': productsPage,
  '#/stores': storesPage,
  '#/delivery': deliveryPage,
  '#/ads': adsPage,
  '#/users': usersPage,
};

async function router() {
  const route = location.hash.split('?')[0] || '#/';
  if (route === '#/login') return loginPage();
  if (!state.user) {
    try {
      state.user = await api('GET', '/auth/me');
    } catch {
      return;
    }
  }
  if (!state.meta) state.meta = await api('GET', '/meta');
  const page = ROUTES[route] || dashboardPage;
  try {
    await page();
  } catch (err) {
    toast(err.message, true);
  }
}
window.addEventListener('hashchange', () => {
  modal.close();
  router();
});
router();

// ---------- login ----------
function loginPage() {
  app.innerHTML = `
    <div class="card login">
      <h2>تسجيل الدخول</h2>
      <form class="stack" id="login">
        <label>اسم المستخدم<input name="username" required autofocus></label>
        <label>كلمة السر<input name="password" type="password" required></label>
        <button class="btn primary">دخول</button>
      </form>
    </div>`;
  document.getElementById('login').onsubmit = guard(async (e) => {
    e.preventDefault();
    state.user = await api('POST', '/auth/login', formData(e.target));
    location.hash = '#/';
  });
}

// ---------- dashboard ----------
async function dashboardPage() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  const s = await api('GET', `/stats?from=${from}&to=${to}`);
  const max = Math.max(1, ...s.daily.map((d) => d.orders));
  const main = shell(`
    <h2>لوحة التحكم</h2>
    <form class="bar" id="range">
      <label>من<input type="date" name="from" value="${esc(from)}"></label>
      <label>إلى<input type="date" name="to" value="${esc(to)}"></label>
      <button class="btn">عرض</button>
      <button class="btn" type="button" data-range="7">7 أيام</button>
      <button class="btn" type="button" data-range="30">30 يوم</button>
      <button class="btn" type="button" data-range="">الكل</button>
    </form>
    <div class="kpis">
      <div class="kpi"><div class="l">الطلبيات</div><div class="v">${s.orders}</div></div>
      <div class="kpi"><div class="l">في انتظار التأكيد</div><div class="v">${(s.by_status.new || 0) + (s.by_status.no_answer || 0) + (s.by_status.postponed || 0)}</div></div>
      <div class="kpi"><div class="l">نسبة التأكيد</div><div class="v">${pct(s.confirmation_rate)}</div></div>
      <div class="kpi"><div class="l">نسبة التوصيل</div><div class="v">${pct(s.delivery_rate)}</div></div>
      <div class="kpi"><div class="l">المبيعات (مستلمة)</div><div class="v">${money(s.revenue)}</div></div>
      <div class="kpi"><div class="l">الإشهار</div><div class="v">${money(s.ad_spend)}</div></div>
      <div class="kpi"><div class="l">الفايدة الصافية</div><div class="v ${s.profit < 0 ? 'neg' : 'pos'}">${money(s.profit)}</div></div>
    </div>
    <div class="card">
      <div class="tabs">${Object.keys(STATUS_LABELS).map((k) =>
        `<a class="tab" href="#/orders?status=${k}">${STATUS_LABELS[k]} <span class="n">${s.by_status[k] || 0}</span></a>`).join('')}</div>
      <div class="muted">الطلبيات في آخر 30 يوم</div>
      <div class="bars">${s.daily.map((d) =>
        `<div style="height:${(d.orders / max) * 100}%" title="${d.day}: ${d.orders} / مؤكدة ${d.confirmed}"><span>${d.orders}</span></div>`).join('')}</div>
    </div>
    ${s.low_stock.length ? `<div class="alert">مخزون ناقص: ${s.low_stock.map((p) => `${esc(p.name)} (${p.stock})`).join('، ')}</div>` : ''}
    <h3>الفايدة لكل منتج</h3>
    <div class="table-wrap"><table>
      <tr><th>المنتج</th><th>طلبيات</th><th>تأكيد</th><th>مستلمة</th><th>روتور</th><th>نسبة التوصيل</th>
        <th>المبيعات</th><th>سعر الشراء</th><th>الإشهار</th><th>تكلفة/طلبية</th><th>الفايدة</th><th>المخزون</th></tr>
      ${s.products.map((p) => `<tr>
        <td>${esc(p.name)}</td><td class="num">${p.orders}</td><td class="num">${pct(p.confirmation_rate)}</td>
        <td class="num">${p.delivered}</td><td class="num">${p.returned}</td><td class="num">${pct(p.delivery_rate)}</td>
        <td class="num">${money(p.revenue)}</td><td class="num">${money(p.cogs)}</td><td class="num">${money(p.ad_spend)}</td>
        <td class="num">${p.cost_per_order == null ? '—' : money(p.cost_per_order)}</td>
        <td class="num ${p.profit < 0 ? 'neg' : 'pos'}">${money(p.profit)}</td>
        <td class="num ${p.stock <= 5 ? 'neg' : ''}">${p.stock}</td></tr>`).join('')}
    </table></div>
    ${s.by_store.length > 1 || s.by_store[0]?.store_id ? `<h3>حسب البوتيك</h3>
    <div class="table-wrap"><table>
      <tr><th>البوتيك</th><th>طلبيات</th><th>مستلمة</th><th>روتور</th><th>المبيعات</th><th>الإشهار</th><th>الفايدة</th></tr>
      ${s.by_store.map((b) => `<tr><td>${esc(b.store_name || 'بلا بوتيك')}</td><td class="num">${b.orders}</td>
        <td class="num">${b.delivered}</td><td class="num">${b.returned}</td><td class="num">${money(b.revenue)}</td>
        <td class="num">${money(b.ad_spend)}</td><td class="num ${b.profit < 0 ? 'neg' : 'pos'}">${money(b.profit)}</td></tr>`).join('')}
    </table></div>` : ''}
    <h3>حسب الولاية</h3>
    <div class="table-wrap"><table>
      <tr><th>الولاية</th><th>طلبيات</th><th>مستلمة</th><th>روتور</th><th>نسبة التوصيل</th></tr>
      ${s.by_wilaya.map((w) => `<tr><td>${wilaya(w.wilaya_code)}</td><td class="num">${w.orders}</td>
        <td class="num">${w.delivered}</td><td class="num">${w.returned}</td>
        <td class="num">${pct(w.delivered + w.returned ? Math.round((w.delivered / (w.delivered + w.returned)) * 1000) / 10 : null)}</td></tr>`).join('')}
    </table></div>`);

  main.querySelector('#range').onsubmit = (e) => {
    e.preventDefault();
    const f = formData(e.target);
    location.hash = `#/?from=${f.from}&to=${f.to}`;
  };
  main.querySelectorAll('[data-range]').forEach((b) => {
    b.onclick = () => {
      const days = b.dataset.range;
      if (!days) return (location.hash = '#/');
      const d = new Date(Date.now() - (Number(days) - 1) * 86400_000).toISOString().slice(0, 10);
      location.hash = `#/?from=${d}&to=${today()}`;
    };
  });
}

// ---------- orders ----------
async function ordersPage() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const status = params.get('status') ?? 'new,no_answer,postponed';
  const q = params.get('q') || '';
  const productId = params.get('product_id') || '';
  const storeId = params.get('store_id') || '';
  const [list, products, stats, stores] = await Promise.all([
    api('GET', `/orders?${new URLSearchParams({ status, q, product_id: productId, store_id: storeId, limit: 200 })}`),
    api('GET', '/products'),
    api('GET', '/stats'),
    api('GET', '/stores'),
  ]);
  const tabs = [
    ['new,no_answer,postponed', 'للتأكيد', ['new', 'no_answer', 'postponed']],
    ...Object.keys(STATUS_LABELS).map((k) => [k, STATUS_LABELS[k], [k]]),
    ['', 'الكل', Object.keys(STATUS_LABELS)],
  ];
  const go = (patch) => {
    const p = new URLSearchParams({ status, q, product_id: productId, store_id: storeId, ...patch });
    location.hash = `#/orders?${p}`;
  };

  const main = shell(`
    <h2>الطلبيات</h2>
    <div class="tabs">${tabs.map(([key, label, keys]) =>
      `<button class="tab ${key === status ? 'active' : ''}" data-status="${key}">${label}
        <span class="n">${keys.reduce((a, k) => a + (stats.by_status[k] || 0), 0)}</span></button>`).join('')}</div>
    <form class="bar" id="filters">
      <input class="grow" name="q" placeholder="بحث: الاسم، الهاتف، المرجع، التراكينغ" value="${esc(q)}">
      <select name="product_id"><option value="">كل المنتجات</option>
        ${products.map((p) => `<option value="${p.id}" ${String(p.id) === productId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      ${stores.length ? `<select name="store_id"><option value="">كل البوتيكات</option>
        ${stores.map((s) => `<option value="${s.id}" ${String(s.id) === storeId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>` : ''}
      <button class="btn">بحث</button>
      <button class="btn primary" type="button" id="new-order">+ طلبية يدوية</button>
      ${state.user.role === 'admin' ? '<button class="btn" type="button" id="sync">تحديث حالات التوصيل</button>' : ''}
    </form>
    <div class="muted" style="margin-bottom:8px">${list.total} طلبية</div>
    <div class="table-wrap"><table>
      <tr><th>المرجع</th><th>التاريخ</th><th>الزبون</th><th>الهاتف</th><th>الولاية</th><th>المنتج</th><th>المجموع</th><th>الحالة</th><th>التوصيل</th></tr>
      ${list.rows.map((o) => `<tr class="click" data-id="${o.id}">
        <td>${esc(o.reference)}${o.duplicate_of ? ' <span class="badge warn">مكررة؟</span>' : ''}</td>
        <td class="muted">${esc(o.created_at.slice(0, 16))}</td>
        <td>${esc(o.customer_name)}</td><td dir="ltr">${esc(o.phone)}</td><td>${wilaya(o.wilaya_code)}</td>
        <td>${esc(o.product_name)} × ${o.quantity}${o.store_name ? ` <span class="muted">${esc(o.store_name)}</span>` : ''}</td><td class="num">${money(o.total)}</td>
        <td>${badge(o.status)}${o.call_attempts ? ` <span class="muted">(${o.call_attempts})</span>` : ''}
          ${o.dispatch_error ? ' <span class="badge cancelled" title="' + esc(o.dispatch_error) + '">خطأ إرسال</span>' : ''}</td>
        <td class="muted">${esc(o.company_name || '')} ${esc(o.tracking || '')}</td></tr>`).join('')}
    </table></div>`);

  main.querySelectorAll('[data-status]').forEach((b) => (b.onclick = () => go({ status: b.dataset.status })));
  main.querySelector('#filters').onsubmit = (e) => {
    e.preventDefault();
    go(formData(e.target));
  };
  main.querySelectorAll('tr[data-id]').forEach((tr) => (tr.onclick = () => openOrder(Number(tr.dataset.id))));
  main.querySelector('#new-order').onclick = () => orderForm(null, products);
  const sync = main.querySelector('#sync');
  if (sync) {
    sync.onclick = guard(async () => {
      sync.disabled = true;
      const r = await api('POST', '/orders/sync-tracking');
      toast(`تم فحص ${r.checked}: ${r.delivered} مستلمة، ${r.returned} روتور${r.errors ? `، ${r.errors} أخطاء` : ''}`);
      router();
    });
  }
}

async function openOrder(id) {
  const o = await api('GET', `/orders/${id}`);
  const open = ['new', 'no_answer', 'postponed'].includes(o.status);
  const box = modal.open(`
    <h3>${esc(o.reference)} ${badge(o.status)}</h3>
    ${o.dispatch_error ? `<div class="alert">خطأ في الإرسال لشركة التوصيل: ${esc(o.dispatch_error)}</div>` : ''}
    ${o.duplicate_of ? `<div class="alert">طلبية مكررة محتملة (نفس الرقم ونفس المنتج، #${o.duplicate_of})</div>` : ''}
    <div class="grid2">
      <div><div class="muted">الزبون</div>${esc(o.customer_name)}</div>
      <div><div class="muted">الهاتف</div><a href="tel:${esc(o.phone)}" dir="ltr">${esc(o.phone)}</a>${o.phone2 ? ` / <a href="tel:${esc(o.phone2)}" dir="ltr">${esc(o.phone2)}</a>` : ''}</div>
      <div><div class="muted">الولاية / البلدية</div>${wilaya(o.wilaya_code)} / ${esc(o.commune || '—')}</div>
      <div><div class="muted">العنوان</div>${esc(o.address || '—')} ${o.stop_desk ? '<span class="badge">مكتب</span>' : ''}</div>
      <div><div class="muted">المنتج</div>${esc(o.product_name)} × ${o.quantity}${o.store_name ? ` <span class="muted">(${esc(o.store_name)})</span>` : ''}</div>
      <div><div class="muted">المجموع</div>${money(o.unit_price * o.quantity)} + توصيل ${money(o.delivery_fee)} = <b>${money(o.total)}</b></div>
      <div><div class="muted">شركة التوصيل</div>${esc(o.company_name || 'غير محددة')} ${esc(o.tracking || '')}</div>
      <div><div class="muted">المصدر</div>${o.source === 'landing' ? 'صفحة الهبوط' : 'يدوي'} ${o.utm_campaign ? `· ${esc(o.utm_campaign)}` : ''}</div>
    </div>
    ${o.notes ? `<p><span class="muted">ملاحظة:</span> ${esc(o.notes)}</p>` : ''}
    <hr>
    <label>ملاحظة على الإجراء<input id="note" placeholder="اختياري"></label>
    <div class="actions" style="margin-top:10px">
      ${open ? `
        <button class="btn primary" data-action="confirm">✔ تأكيد وإرسال</button>
        <button class="btn" data-action="no_answer">ما ردش</button>
        <button class="btn" data-action="postpone">تأجيل</button>
        <button class="btn danger" data-action="cancel">إلغاء</button>` : ''}
      ${o.status === 'confirmed' ? `
        <button class="btn primary" data-dispatch>إعادة الإرسال لشركة التوصيل</button>
        <button class="btn" data-manual>إدخال تراكينغ يدوياً</button>
        <button class="btn danger" data-action="cancel">إلغاء</button>` : ''}
      ${o.status === 'dispatched' ? `
        <button class="btn primary" data-action="delivered">مستلمة</button>
        <button class="btn danger" data-action="returned">روتور</button>` : ''}
      ${o.status === 'cancelled' ? '<button class="btn" data-action="reopen">إعادة فتح</button>' : ''}
      ${['new', 'no_answer', 'postponed', 'confirmed'].includes(o.status) ? '<button class="btn" data-edit>تعديل</button>' : ''}
      <button class="btn" data-close>إغلاق</button>
    </div>
    <h4>السجل</h4>
    <ul class="timeline">${o.events.map((e) =>
      `<li><span class="muted">${esc(e.created_at)}</span> · ${esc(EVENT_LABELS[e.type] || e.type)} ${e.message ? `— ${esc(e.message)}` : ''} ${e.username ? `<span class="muted">(${esc(e.username)})</span>` : ''}</li>`).join('')}</ul>`);

  const after = (r) => {
    toast(r.status === 'dispatched' ? `تبعثت لـ ${r.company_name}${r.tracking ? ` (${r.tracking})` : ''}` : r.dispatch_error ? `مؤكدة، بصح الإرسال فشل: ${r.dispatch_error}` : 'تم', Boolean(r.dispatch_error));
    modal.close();
    router();
  };
  box.querySelectorAll('[data-action]').forEach((b) => {
    b.onclick = guard(async () => {
      b.disabled = true;
      try {
        after(await api('POST', `/orders/${id}/action`, { action: b.dataset.action, note: box.querySelector('#note').value }));
      } finally {
        b.disabled = false;
      }
    });
  });
  const retry = box.querySelector('[data-dispatch]');
  if (retry) retry.onclick = guard(async () => after(await api('POST', `/orders/${id}/dispatch`, {})));
  const manual = box.querySelector('[data-manual]');
  if (manual) {
    manual.onclick = guard(async () => {
      const tracking = prompt('رقم التراكينغ');
      if (tracking) after(await api('POST', `/orders/${id}/dispatch`, { tracking }));
    });
  }
  const edit = box.querySelector('[data-edit]');
  if (edit) edit.onclick = guard(async () => orderForm(o, await api('GET', '/products')));
}

async function orderForm(order, products) {
  const companies = await api('GET', '/delivery/companies');
  const o = order || { quantity: 1, wilaya_code: 16, stop_desk: 0 };
  const box = modal.open(`
    <h3>${order ? `تعديل ${esc(order.reference)}` : 'طلبية جديدة'}</h3>
    <form class="stack" id="order-form">
      ${order ? '' : `<label>المنتج<select name="product_id" required>${products.filter((p) => p.active)
        .map((p) => `<option value="${p.id}">${esc(p.name)} — ${money(p.price)}</option>`).join('')}</select></label>`}
      <div class="grid2">
        <label>الاسم<input name="customer_name" value="${esc(o.customer_name)}" required></label>
        <label>الهاتف<input name="phone" value="${esc(o.phone)}" required dir="ltr"></label>
        <label>هاتف 2<input name="phone2" value="${esc(o.phone2)}" dir="ltr"></label>
        <label>الولاية<select name="wilaya_code">${wilayaOptions(o.wilaya_code)}</select></label>
        <label>البلدية<input name="commune" value="${esc(o.commune)}"></label>
        <label>العنوان<input name="address" value="${esc(o.address)}"></label>
        <label>الكمية<input name="quantity" type="number" min="1" value="${o.quantity}"></label>
        <label>سعر الوحدة<input name="unit_price" type="number" value="${order ? o.unit_price : ''}" placeholder="سعر المنتج"></label>
        ${order ? `<label>سعر التوصيل<input name="delivery_fee" type="number" value="${o.delivery_fee}"></label>
        <label>شركة التوصيل<select name="company_id"><option value="">حسب الولاية</option>
          ${companies.map((c) => `<option value="${c.id}" ${c.id === o.company_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>` : ''}
      </div>
      <label class="check"><input type="checkbox" name="stop_desk" ${o.stop_desk ? 'checked' : ''}> استلام من المكتب (Stop desk)</label>
      <label>ملاحظة<textarea name="notes">${esc(o.notes)}</textarea></label>
      <div class="actions"><button class="btn primary">حفظ</button><button class="btn" type="button" data-close>إلغاء</button></div>
    </form>`);
  box.querySelector('#order-form').onsubmit = guard(async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    f.stop_desk = Boolean(f.stop_desk);
    if (f.unit_price === '') delete f.unit_price;
    if (order) {
      if (f.company_id === '') f.company_id = null;
      if (f.wilaya_code != o.wilaya_code || f.stop_desk !== Boolean(o.stop_desk)) delete f.delivery_fee;
      await api('PUT', `/orders/${order.id}`, f);
    } else {
      await api('POST', '/orders', f);
    }
    modal.close();
    toast('تم الحفظ');
    router();
  });
}

// ---------- products ----------
async function productsPage() {
  const [products, stores] = await Promise.all([api('GET', '/products'), api('GET', '/stores')]);
  const isAdmin = state.user.role === 'admin';
  const main = shell(`
    <h2>المنتجات</h2>
    ${isAdmin ? '<div class="bar"><button class="btn primary" id="add">+ منتج جديد</button></div>' : ''}
    <div class="table-wrap"><table>
      <tr><th>المنتج</th><th>البوتيك</th><th>السعر</th><th>سعر الشراء</th><th>المخزون</th><th>صفحة الهبوط</th><th>طلبيات</th><th></th></tr>
      ${products.map((p) => `<tr>
        <td>${esc(p.name)} ${p.sku ? `<span class="muted">${esc(p.sku)}</span>` : ''} ${p.active ? '' : '<span class="badge">موقف</span>'}</td>
        <td>${esc(p.store_name || '—')}</td>
        <td class="num">${money(p.price)}</td><td class="num">${money(p.cost)}</td>
        <td class="num ${p.stock <= 5 ? 'neg' : ''}">${p.stock}</td>
        <td>${p.landing_url ? `<a href="${esc(p.landing_url)}" target="_blank" rel="noopener">فتح</a>` : '<span class="muted">—</span>'}</td>
        <td class="num">${p.orders_count} <span class="muted">(${p.pending_count} للتأكيد)</span></td>
        <td class="actions">
          <button class="btn small" data-embed="${p.id}">ربط صفحة الهبوط</button>
          ${isAdmin ? `<button class="btn small" data-edit="${p.id}">تعديل</button>
          <button class="btn small" data-stock="${p.id}">المخزون</button>` : ''}
        </td></tr>`).join('')}
    </table></div>`);

  const byId = (id) => products.find((p) => p.id === Number(id));
  const add = main.querySelector('#add');
  if (add) add.onclick = () => productForm(null, stores);
  main.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => productForm(byId(b.dataset.edit), stores)));
  main.querySelectorAll('[data-embed]').forEach((b) => (b.onclick = () => embedDialog(byId(b.dataset.embed))));
  main.querySelectorAll('[data-stock]').forEach((b) => (b.onclick = guard(() => stockDialog(byId(b.dataset.stock)))));
}

function productForm(p, stores) {
  const x = p || { active: 1 };
  const box = modal.open(`
    <h3>${p ? 'تعديل المنتج' : 'منتج جديد'}</h3>
    <form class="stack" id="product-form">
      <div class="grid2">
        <label>الاسم<input name="name" value="${esc(x.name)}" required></label>
        <label>SKU<input name="sku" value="${esc(x.sku)}"></label>
        <label>سعر البيع<input name="price" type="number" value="${x.price ?? ''}" required></label>
        <label>سعر الشراء<input name="cost" type="number" value="${x.cost ?? ''}"></label>
        ${p ? '' : '<label>المخزون الأولي<input name="stock" type="number" value="0"></label>'}
        <label>البوتيك<select name="store_id"><option value="">—</option>${stores
          .map((s) => `<option value="${s.id}" ${s.id === x.store_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label>بودجي الحملة في النهار<input name="ad_daily_budget" type="number" step="0.5" value="${x.ad_daily_budget ?? ''}" placeholder="فارغ = 9"></label>
      </div>
      <label>رابط صفحة الهبوط<input name="landing_url" value="${esc(x.landing_url)}" placeholder="https://..." dir="ltr"></label>
      <label class="check"><input type="checkbox" name="active" ${x.active ? 'checked' : ''}> مفعل (يستقبل طلبيات)</label>
      <div class="actions"><button class="btn primary">حفظ</button><button class="btn" type="button" data-close>إلغاء</button></div>
    </form>`);
  box.querySelector('#product-form').onsubmit = guard(async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    f.active = Boolean(f.active);
    await (p ? api('PUT', `/products/${p.id}`, f) : api('POST', '/products', f));
    modal.close();
    toast('تم الحفظ');
    router();
  });
}

function embedDialog(p) {
  const origin = location.origin;
  const snippet = `<div id="erp-order-form"></div>\n<script src="${origin}/embed.js" data-key="${p.public_key}"></script>`;
  const custom = `<script src="${origin}/embed.js" data-key="${p.public_key}"></script>\n<script>\n  // من الفورم تاعك:\n  ErpOrder.submit({ name, phone, wilaya, commune, address, quantity, stop_desk })\n    .then(r => alert('تم: ' + r.reference));\n</script>`;
  const box = modal.open(`
    <h3>ربط صفحة الهبوط: ${esc(p.name)}</h3>
    <p class="muted">حط هاد الكود في صفحة الهبوط تاع المنتج (HTML). يظهر فورم الطلب، وكل طلبية تدخل وحدها للـ ERP في "الطلبيات" مربوطة بهاد المنتج.</p>
    <pre class="code">${esc(snippet)}</pre>
    <div class="actions"><button class="btn" data-copy="snippet">نسخ الكود</button></div>
    <p class="muted">ولا رابط مباشر للفورم (تقدر تحطو في iframe):</p>
    <pre class="code">${esc(`${origin}/form.html?key=${p.public_key}`)}</pre>
    <details><summary class="muted">عندك فورم خاص بيك؟</summary><pre class="code">${esc(custom)}</pre></details>
    <div class="actions" style="margin-top:12px">
      ${state.user.role === 'admin' ? '<button class="btn danger" data-regen>تغيير المفتاح</button>' : ''}
      <button class="btn" data-close>إغلاق</button>
    </div>`);
  box.querySelector('[data-copy]').onclick = () => navigator.clipboard.writeText(snippet).then(() => toast('تم النسخ'));
  const regen = box.querySelector('[data-regen]');
  if (regen) {
    regen.onclick = guard(async () => {
      if (!confirm('الكود القديم يحبس يخدم. متأكد؟')) return;
      const updated = await api('POST', `/products/${p.id}/regenerate-key`);
      embedDialog(updated);
    });
  }
}

async function stockDialog(p) {
  const moves = await api('GET', `/products/${p.id}/stock-movements`);
  const box = modal.open(`
    <h3>مخزون: ${esc(p.name)} — ${p.stock}</h3>
    <form class="bar" id="stock-form">
      <label>الكمية (+ دخول / - خروج)<input name="quantity" type="number" required></label>
      <label class="grow">السبب<input name="reason" placeholder="دخول سلعة، تصحيح، كاسي..."></label>
      <button class="btn primary">حفظ</button>
    </form>
    <div class="table-wrap"><table>
      <tr><th>التاريخ</th><th>الكمية</th><th>السبب</th><th>الطلبية</th></tr>
      ${moves.map((m) => `<tr><td class="muted">${esc(m.created_at)}</td>
        <td class="num ${m.quantity < 0 ? 'neg' : 'pos'}">${m.quantity > 0 ? '+' : ''}${m.quantity}</td>
        <td>${esc(m.reason)}</td><td>${esc(m.reference || '')}</td></tr>`).join('')}
    </table></div>
    <div class="actions" style="margin-top:12px"><button class="btn" data-close>إغلاق</button></div>`);
  box.querySelector('#stock-form').onsubmit = guard(async (e) => {
    e.preventDefault();
    const updated = await api('POST', `/products/${p.id}/stock`, formData(e.target));
    toast('تم');
    stockDialog(updated);
    if (location.hash.startsWith('#/products')) productsPage();
  });
}

// ---------- delivery ----------
async function deliveryPage() {
  const [companies, routing] = await Promise.all([api('GET', '/delivery/companies'), api('GET', '/delivery/routes')]);
  const companyOptions = (selected, emptyLabel) => `<option value="">${emptyLabel}</option>` +
    companies.map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const main = shell(`
    <h2>شركات التوصيل</h2>
    <div class="bar"><button class="btn primary" id="add">+ شركة توصيل</button></div>
    <div class="table-wrap" style="margin-bottom:20px"><table>
      <tr><th>الاسم</th><th>النوع</th><th>الرابط</th><th>Token</th><th>الحالة</th><th></th></tr>
      ${companies.map((c) => `<tr><td>${esc(c.name)}</td><td>${PROVIDER_LABELS[c.provider] || c.provider}</td>
        <td dir="ltr" class="muted">${esc(c.base_url || '')}</td><td class="muted" dir="ltr">${esc(c.api_token || '—')}</td>
        <td>${c.active ? '<span class="badge delivered">مفعلة</span>' : '<span class="badge">موقفة</span>'}</td>
        <td><button class="btn small" data-edit="${c.id}">تعديل</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">زيد شركة التوصيل الأولى</td></tr>'}
    </table></div>

    <h2>التوزيع حسب الولاية</h2>
    <p class="muted">كي تتأكد طلبية، تتبعث أوتوماتيكيا لحساب التوصيل تاع البوتيك تاعها (صفحة "البوتيكات"). إذا البوتيك ما عندهاش حساب، تروح للشركة المربوطة بالولاية هنا. الولايات بلا شركة تروح للشركة الافتراضية. سعر التوصيل هنا هو اللي يتزاد للزبون في الفورم.</p>
    <form id="routes">
      <div class="card grid3">
        <label>الشركة الافتراضية<select name="default_company_id">${companyOptions(routing.default_company_id, '— بلا —')}</select></label>
        <label class="check"><input type="checkbox" name="auto_dispatch" ${routing.auto_dispatch ? 'checked' : ''}> إرسال أوتوماتيكي عند التأكيد</label>
        <label>تطبيق شركة على كل الولايات<select id="bulk">${companyOptions(null, '—')}</select></label>
      </div>
      <div class="table-wrap"><table>
        <tr><th>الولاية</th><th>شركة التوصيل</th><th>توصيل للمنزل</th><th>مكتب (Stop desk)</th></tr>
        ${routing.routes.map((r) => `<tr data-code="${r.code}"><td>${r.code} - ${esc(r.name_ar)} <span class="muted">${esc(r.name_fr)}</span></td>
          <td><select name="company_id">${companyOptions(r.company_id, 'الافتراضية')}</select></td>
          <td><input name="home_fee" type="number" value="${r.home_fee}" style="width:100px"></td>
          <td><input name="desk_fee" type="number" value="${r.desk_fee}" style="width:100px"></td></tr>`).join('')}
      </table></div>
      <div class="bar" style="margin-top:12px"><button class="btn primary">حفظ التوزيع</button></div>
    </form>`);

  main.querySelector('#add').onclick = () => companyForm(null);
  main.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => companyForm(companies.find((c) => c.id === Number(b.dataset.edit)))));
  main.querySelector('#bulk').onchange = (e) => {
    main.querySelectorAll('tr[data-code] select[name=company_id]').forEach((s) => (s.value = e.target.value));
  };
  main.querySelector('#routes').onsubmit = guard(async (e) => {
    e.preventDefault();
    const form = e.target;
    const routes = [...form.querySelectorAll('tr[data-code]')].map((tr) => ({
      wilaya_code: Number(tr.dataset.code),
      company_id: tr.querySelector('[name=company_id]').value || null,
      home_fee: tr.querySelector('[name=home_fee]').value,
      desk_fee: tr.querySelector('[name=desk_fee]').value,
    }));
    await api('PUT', '/delivery/routes', {
      routes,
      default_company_id: form.default_company_id.value || null,
      auto_dispatch: form.auto_dispatch.checked,
    });
    toast('تم حفظ التوزيع');
  });
}

function companyForm(c) {
  const x = c || { provider: 'ecotrack', active: 1 };
  const box = modal.open(`
    <h3>${c ? 'تعديل شركة التوصيل' : 'شركة توصيل جديدة'}</h3>
    <form class="stack" id="company-form">
      <label>الاسم<input name="name" value="${esc(x.name)}" required placeholder="مثلا: Ecotrack Oran"></label>
      <label>النوع<select name="provider">${Object.entries(PROVIDER_LABELS)
        .map(([k, v]) => `<option value="${k}" ${x.provider === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>رابط المنصة (Ecotrack)<input name="base_url" value="${esc(x.base_url)}" placeholder="https://xxxx.ecotrack.dz" dir="ltr"></label>
      <label>API Token<input name="api_token" placeholder="${c?.api_token ? 'خليه فارغ باش يبقى القديم' : ''}" dir="ltr"></label>
      <label class="check"><input type="checkbox" name="active" ${x.active ? 'checked' : ''}> مفعلة</label>
      <p class="muted">Token تلقاه في حساب Ecotrack تاعك: Paramètres → API. أي شركة تخدم على منصة Ecotrack تخدم هنا بالرابط تاعها.</p>
      <div class="actions"><button class="btn primary">حفظ</button><button class="btn" type="button" data-close>إلغاء</button></div>
    </form>`);
  box.querySelector('#company-form').onsubmit = guard(async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    f.active = Boolean(f.active);
    await (c ? api('PUT', `/delivery/companies/${c.id}`, f) : api('POST', '/delivery/companies', f));
    modal.close();
    toast('تم الحفظ');
    router();
  });
}

// ---------- stores ----------
async function storesPage() {
  const [stores, companies] = await Promise.all([api('GET', '/stores'), api('GET', '/delivery/companies')]);
  const main = shell(`
    <h2>البوتيكات</h2>
    <p class="muted">كل بوتيك تبعث الطلبيات المؤكدة لحساب التوصيل تاعها. تقدر تزيد استثناءات: ولايات تروح لشركة أخرى. المنتجات تتربط بالبوتيك من صفحة "المنتجات".</p>
    <div class="bar"><button class="btn primary" id="add">+ بوتيك</button></div>
    <div class="table-wrap"><table>
      <tr><th>البوتيك</th><th>حساب التوصيل</th><th>استثناءات حسب الولاية</th><th>منتجات</th><th></th></tr>
      ${stores.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.company_name || '— (حسب الولاية)')}</td>
        <td class="muted">${s.routes.map((r) => `${wilaya(r.wilaya_code)} ← ${esc(r.company_name)}`).join('، ') || '—'}</td>
        <td class="num">${s.products_count}</td>
        <td><button class="btn small" data-edit="${s.id}">تعديل</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">زيد البوتيك الأولى</td></tr>'}
    </table></div>`);
  main.querySelector('#add').onclick = () => storeForm(null, companies);
  main.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => storeForm(stores.find((s) => s.id === Number(b.dataset.edit)), companies)));
}

function storeForm(store, companies) {
  const x = store || { routes: [] };
  const companyOptions = (selected) => companies
    .map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const routeRow = (r = {}) => `<div class="grid2 route-row">
    <select name="wilaya_code">${wilayaOptions(r.wilaya_code)}</select>
    <div class="actions"><select name="company_id" style="flex:1">${companyOptions(r.company_id)}</select>
    <button class="btn small danger" type="button" data-remove>✕</button></div></div>`;
  const box = modal.open(`
    <h3>${store ? `تعديل ${esc(store.name)}` : 'بوتيك جديدة'}</h3>
    <form class="stack" id="store-form">
      <label>الاسم<input name="name" value="${esc(x.name)}" required></label>
      <label>حساب التوصيل تاع البوتيك<select name="company_id"><option value="">— حسب الولاية (صفحة التوصيل)</option>${companyOptions(x.company_id)}</select></label>
      <div class="muted">استثناءات: هاد الولايات تروح لشركة أخرى</div>
      <div class="stack" id="routes">${x.routes.map(routeRow).join('')}</div>
      <div><button class="btn small" type="button" id="add-route">+ استثناء</button></div>
      <div class="actions">
        <button class="btn primary">حفظ</button>
        ${store ? '<button class="btn danger" type="button" data-delete>حذف</button>' : ''}
        <button class="btn" type="button" data-close>إلغاء</button>
      </div>
    </form>`);
  const routes = box.querySelector('#routes');
  const bindRemove = () => routes.querySelectorAll('[data-remove]').forEach((b) => (b.onclick = () => b.closest('.route-row').remove()));
  bindRemove();
  box.querySelector('#add-route').onclick = () => {
    if (!companies.length) return toast('زيد شركة توصيل الأولى', true);
    routes.insertAdjacentHTML('beforeend', routeRow());
    bindRemove();
  };
  const del = box.querySelector('[data-delete]');
  if (del) {
    del.onclick = guard(async () => {
      if (!confirm('حذف البوتيك؟ المنتجات تبقى بلا بوتيك.')) return;
      await api('DELETE', `/stores/${store.id}`);
      modal.close();
      router();
    });
  }
  box.querySelector('#store-form').onsubmit = guard(async (e) => {
    e.preventDefault();
    const body = {
      name: e.target.elements.name.value,
      company_id: e.target.company_id.value || null,
      routes: [...routes.querySelectorAll('.route-row')].map((row) => ({
        wilaya_code: Number(row.querySelector('[name=wilaya_code]').value),
        company_id: Number(row.querySelector('[name=company_id]').value),
      })),
    };
    await (store ? api('PUT', `/stores/${store.id}`, body) : api('POST', '/stores', body));
    modal.close();
    toast('تم الحفظ');
    router();
  });
}

// ---------- ad spend ----------
async function adsPage() {
  const [rows, products] = await Promise.all([api('GET', '/ad-spend'), api('GET', '/products')]);
  const main = shell(`
    <h2>مصاريف الإشهار</h2>
    <p class="muted">دخل شحال صرفت في Meta Ads (ولا غيرها) لكل منتج في كل يوم، باش تحسب الفايدة الصافية والتكلفة لكل طلبية.</p>
    <form class="bar card" id="ad-form">
      <label>المنتج<select name="product_id" required>${products.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
      <label>التاريخ<input type="date" name="date" value="${today()}" required></label>
      <label>المبلغ (دج)<input type="number" name="amount" required></label>
      <button class="btn primary">حفظ</button>
    </form>
    <div class="table-wrap"><table>
      <tr><th>التاريخ</th><th>المنتج</th><th>المبلغ</th><th></th></tr>
      ${rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.product_name)}</td><td class="num">${money(r.amount)}</td>
        <td><button class="btn small danger" data-del="${r.id}">حذف</button></td></tr>`).join('')}
    </table></div>`);
  main.querySelector('#ad-form').onsubmit = guard(async (e) => {
    e.preventDefault();
    await api('POST', '/ad-spend', formData(e.target));
    toast('تم');
    router();
  });
  main.querySelectorAll('[data-del]').forEach((b) => (b.onclick = guard(async () => {
    await api('DELETE', `/ad-spend/${b.dataset.del}`);
    router();
  })));
}

// ---------- users ----------
async function usersPage() {
  const users = await api('GET', '/users');
  const main = shell(`
    <h2>المستخدمين</h2>
    <form class="bar card" id="user-form">
      <label>اسم المستخدم<input name="username" required></label>
      <label>كلمة السر<input name="password" type="password" required minlength="6"></label>
      <label>الدور<select name="role"><option value="agent">مؤكدة (تأكيد الطلبيات)</option><option value="admin">مدير</option></select></label>
      <button class="btn primary">إضافة</button>
    </form>
    <div class="table-wrap"><table>
      <tr><th>الاسم</th><th>الدور</th><th>تاريخ الإنشاء</th><th></th></tr>
      ${users.map((u) => `<tr><td>${esc(u.username)}</td><td>${u.role === 'admin' ? 'مدير' : 'مؤكدة'}</td><td class="muted">${esc(u.created_at)}</td>
        <td class="actions"><button class="btn small" data-pass="${u.id}">كلمة السر</button>
        ${u.id === state.user.id ? '' : `<button class="btn small danger" data-del="${u.id}">حذف</button>`}</td></tr>`).join('')}
    </table></div>`);
  main.querySelector('#user-form').onsubmit = guard(async (e) => {
    e.preventDefault();
    await api('POST', '/users', formData(e.target));
    toast('تم');
    router();
  });
  main.querySelectorAll('[data-pass]').forEach((b) => (b.onclick = guard(async () => {
    const password = prompt('كلمة السر الجديدة (6 حروف على الأقل)');
    if (password) {
      await api('PUT', `/users/${b.dataset.pass}/password`, { password });
      toast('تم تغيير كلمة السر');
    }
  })));
  main.querySelectorAll('[data-del]').forEach((b) => (b.onclick = guard(async () => {
    if (!confirm('حذف هذا المستخدم؟')) return;
    await api('DELETE', `/users/${b.dataset.del}`);
    router();
  })));
}
