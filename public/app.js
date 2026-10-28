// Admin interface: a small hash-routed single page app, no build step.

const STATUS_LABELS = {
  new: 'جديدة', no_answer: 'ما ردش', postponed: 'مؤجلة', confirmed: 'مؤكدة', cancelled: 'ملغاة',
  dispatched: 'عند التوصيل', delivered: 'مستلمة', returned: 'روتور', fake: 'وهمية',
};
const EVENT_LABELS = {
  created: 'تسجلت', duplicate: 'مكررة؟', no_answer: 'ما ردش', postponed: 'تأجلت', confirmed: 'تأكدت',
  cancelled: 'تلغات', reopened: 'تعاودت تفتحت', dispatched: 'تبعثت للتوصيل', dispatch_failed: 'فشل الإرسال',
  delivered: 'تستلمت', returned: 'روتور', edited: 'تعدلت',
};
const SOURCE_LABELS = { landing: 'صفحة الهبوط', sheet: 'شيت', abandoned: 'متروكة', manual: 'يدوي' };
const SOURCE_ICONS = { landing: '🌐', sheet: '📗', abandoned: '🛒', manual: '✍️' };
// wa.me wants the number in international form, without the leading 0.
const whatsapp = (phone) => `https://wa.me/213${String(phone).replace(/^0/, '')}`;
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
// Timestamps come from the server in UTC; show them in Algeria time.
const fmtDate = (v) => (v ? new Date(v).toLocaleString('fr-DZ', { timeZone: 'Africa/Algiers', dateStyle: 'short', timeStyle: 'short' }) : '');

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
  ['#/orders', 'تأكيد الطلبيات'],
  ['#/tracking', 'تتبع الطلبيات'],
  ['#/products', 'المنتجات'],
  ['#/stores', 'البوتيكات', 'admin'],
  ['#/sheets', 'الشيتات', 'admin'],
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
  '#/orders': () => ordersPage('confirm'),
  '#/tracking': () => ordersPage('tracking'),
  '#/products': productsPage,
  '#/stores': storesPage,
  '#/sheets': sheetsPage,
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
        `<a class="tab" href="${orderPageOf(k)}?status=${k}">${STATUS_LABELS[k]} <span class="n">${s.by_status[k] || 0}</span></a>`).join('')}</div>
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
const PAGE_SIZE = 50;
const ORDER_FILTERS = ['status', 'q', 'product_id', 'store_id', 'wilaya', 'company_id', 'source', 'stop_desk', 'page'];

// Two pages on the same table: confirmation (orders still to call) and
// tracking (confirmed orders, at the delivery company, delivered, returned).
const ORDER_PAGES = {
  confirm: { hash: '#/orders', title: 'تأكيد الطلبيات', statuses: ['new', 'no_answer', 'postponed', 'cancelled', 'fake'], first: 'new,no_answer,postponed' },
  tracking: { hash: '#/tracking', title: 'تتبع الطلبيات', statuses: ['confirmed', 'dispatched', 'delivered', 'returned'] },
};
ORDER_PAGES.tracking.first = ORDER_PAGES.tracking.statuses.join(',');
const orderPageOf = (status) => (ORDER_PAGES.tracking.statuses.includes(status) ? '#/tracking' : '#/orders');

async function ordersPage(mode = 'confirm') {
  const P = ORDER_PAGES[mode];
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const f = Object.fromEntries(ORDER_FILTERS.map((k) => [k, params.get(k) ?? '']));
  if (!params.has('status') || !f.status) f.status = P.first;
  const page = Math.max(1, Number(f.page) || 1);
  const query = Object.fromEntries(Object.entries({ ...f, page: '' }).filter(([, v]) => v !== ''));
  const [list, products, stats, stores, companies] = await Promise.all([
    api('GET', `/orders?${new URLSearchParams({ ...query, status: f.status, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })}`),
    api('GET', '/products'),
    api('GET', '/stats'),
    api('GET', '/stores'),
    api('GET', '/delivery/companies'),
  ]);
  const tabs = mode === 'confirm'
    ? [[P.first, 'للتأكيد', P.first.split(',')], ...P.statuses.map((k) => [k, STATUS_LABELS[k], [k]]), [P.statuses.join(','), 'الكل', P.statuses]]
    : [[P.first, 'الكل', P.statuses], ...P.statuses.map((k) => [k, STATUS_LABELS[k], [k]])];
  const go = (patch) => {
    const p = new URLSearchParams(Object.entries({ ...f, page: '', ...patch }).filter(([, v]) => v !== ''));
    location.hash = `${P.hash}?${p}`;
  };
  // A header with a dropdown filter, like Ecotrack's column headers.
  const hfilter = (label, key, options) => `<th class="hf"><select data-filter="${key}" class="${f[key] ? 'on' : ''}">
      <option value="">${label}</option>
      ${options.map(([v, l]) => `<option value="${v}" ${String(v) === f[key] ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></th>`;
  const isAdmin = state.user.role === 'admin';
  const from = list.total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));

  const main = shell(`
    <h2>${P.title}</h2>
    <div class="tabs">${tabs.map(([key, label, keys]) =>
      `<button class="tab ${key === f.status ? 'active' : ''}" data-status="${key}">${label}
        <span class="n">${keys.reduce((a, k) => a + (stats.by_status[k] || 0), 0)}</span></button>`).join('')}</div>
    <form class="bar" id="filters">
      <input class="grow" name="q" placeholder="بحث: الاسم، الهاتف، رقم الطلبية، التراكينغ" value="${esc(f.q)}">
      <button class="btn">بحث</button>
      ${ORDER_FILTERS.some((k) => !['status', 'page'].includes(k) && f[k]) ? '<button class="btn" type="button" id="clear">مسح الفلاتر</button>' : ''}
      ${mode === 'confirm' ? '<button class="btn primary" type="button" id="new-order">+ طلبية يدوية</button>' : ''}
      ${isAdmin && mode === 'tracking' ? '<button class="btn" type="button" id="sync">تحديث حالات التوصيل</button>' : ''}
    </form>
    <div class="bulk hidden" id="bulk"><b id="bulk-n"></b>
      <select id="bulk-action"><option value="">تبديل الحالة للمحددين…</option>
        <option value="confirm">مؤكدة</option><option value="no_answer">ما ردش</option>
        <option value="postpone">مؤجلة</option><option value="cancel">ملغاة</option></select>
      <button class="btn small" id="bulk-go">تطبيق</button></div>
    <div class="top-scroll" id="top-scroll"><div></div></div>
    <div class="table-wrap orders-wrap" id="orders-wrap"><table class="orders">
      <thead><tr>
        <th><input type="checkbox" id="check-all"></th>
        ${hfilter('المصدر', 'source', Object.entries(SOURCE_LABELS))}
        <th>رقم الطلبية</th><th>التاريخ</th><th>الاسم الكامل</th><th>الهاتف</th><th>اتصال</th>
        ${hfilter('الحالة', 'status', P.statuses.map((k) => [k, STATUS_LABELS[k]]))}
        <th>العنوان</th>
        ${hfilter('البوتيك', 'store_id', stores.map((s) => [s.id, s.name]))}
        ${hfilter('نوع التوصيل', 'stop_desk', [['0', 'المنزل'], ['1', 'مكتب']])}
        ${hfilter('الولاية', 'wilaya', state.meta.wilayas.map((w) => [w.code, `${w.code} - ${w.name_fr}`]))}
        <th>البلدية</th>
        ${hfilter('المنتج', 'product_id', products.map((p) => [p.id, p.name]))}
        <th>سعر المنتج</th><th>الكمية</th><th>سعر التوصيل</th><th>السعر الكلي</th><th>التفاصيل</th>
        ${hfilter('شركة التوصيل', 'company_id', companies.map((c) => [c.id, c.name]))}
        <th>التأكيد بواسطة</th><th>الإجراءات</th>
      </tr></thead>
      <tbody>${list.rows.map((o) => orderRow(o, products, companies, stores)).join('')
        || '<tr><td colspan="22" class="muted" style="text-align:center;padding:30px">ما كاين حتى طلبية</td></tr>'}</tbody>
    </table></div>
    <div class="pager"><span class="muted">${from}-${from ? from + list.rows.length - 1 : 0} من ${list.total}</span>
      <span>${page > 1 ? `<button class="btn small" data-page="${page - 1}">‹ السابقة</button>` : ''}
        <span class="page-n">${page} / ${pages}</span>
        ${page < pages ? `<button class="btn small" data-page="${page + 1}">التالية ›</button>` : ''}</span></div>`);
  bindOrderTable(main.querySelector('table.orders'), list.rows, products, companies, stores);
  syncTopScroll(main.querySelector('#top-scroll'), main.querySelector('#orders-wrap'));

  main.querySelectorAll('[data-status]').forEach((b) => (b.onclick = () => go({ status: b.dataset.status })));
  main.querySelectorAll('[data-filter]').forEach((s) => (s.onchange = () => go({ [s.dataset.filter]: s.value })));
  main.querySelectorAll('[data-page]').forEach((b) => (b.onclick = () => go({ page: b.dataset.page })));
  main.querySelector('#filters').onsubmit = (e) => {
    e.preventDefault();
    go({ q: e.target.elements.q.value });
  };
  const clear = main.querySelector('#clear');
  if (clear) clear.onclick = () => go(Object.fromEntries(ORDER_FILTERS.filter((k) => k !== 'status').map((k) => [k, ''])));
  const add = main.querySelector('#new-order');
  if (add) add.onclick = () => orderForm(null, products);
  const sync = main.querySelector('#sync');
  if (sync) {
    sync.onclick = guard(async () => {
      sync.disabled = true;
      const r = await api('POST', '/orders/sync-tracking');
      toast(`تم فحص ${r.checked}: ${r.delivered} مستلمة، ${r.returned} روتور${r.errors ? `، ${r.errors} أخطاء` : ''}`);
      router();
    });
  }

  // Bulk status change on the checked rows.
  const checked = () => [...main.querySelectorAll('tbody [data-check]:checked')].map((c) => Number(c.closest('tr').dataset.id));
  const refreshBulk = () => {
    const n = checked().length;
    main.querySelector('#bulk').classList.toggle('hidden', !n);
    main.querySelector('#bulk-n').textContent = `${n} محددة`;
  };
  main.querySelector('#check-all').onchange = (e) => {
    main.querySelectorAll('tbody [data-check]').forEach((c) => (c.checked = e.target.checked));
    refreshBulk();
  };
  main.querySelector('table.orders').addEventListener('change', (e) => e.target.matches('[data-check]') && refreshBulk());
  main.querySelector('#bulk-go').onclick = guard(async () => {
    const action = main.querySelector('#bulk-action').value;
    const ids = checked();
    if (!action || !ids.length) return;
    if (!confirm(`${STATUS_LABELS[{ confirm: 'confirmed', no_answer: 'no_answer', postpone: 'postponed', cancel: 'cancelled' }[action]]}: ${ids.length} طلبية؟`)) return;
    let ok = 0;
    const errors = [];
    for (const id of ids) {
      try {
        await api('POST', `/orders/${id}/action`, { action });
        ok += 1;
      } catch (err) {
        errors.push(err.message);
      }
    }
    toast(`تم ${ok} من ${ids.length}${errors.length ? ` · ${errors[0]}` : ''}`, Boolean(errors.length));
    router();
  });
}

// A second horizontal scrollbar above the table, kept in step with the one below.
function syncTopScroll(top, wrap) {
  const fit = () => {
    top.firstElementChild.style.width = `${wrap.scrollWidth}px`;
    top.classList.toggle('hidden', wrap.scrollWidth <= wrap.clientWidth);
  };
  let busy = false;
  const mirror = (from, to) => () => {
    if (busy) return;
    busy = true;
    to.scrollLeft = from.scrollLeft;
    requestAnimationFrame(() => (busy = false));
  };
  top.onscroll = mirror(top, wrap);
  wrap.onscroll = mirror(wrap, top);
  fit();
  new ResizeObserver(fit).observe(wrap);
}

const EDITABLE = ['new', 'no_answer', 'postponed', 'confirmed'];
// Status choices offered in the table for each current status, and the
// confirmation action that moves the order there.
const STATUS_MOVES = {
  new: ['no_answer', 'postponed', 'confirmed', 'cancelled'],
  no_answer: ['new', 'no_answer', 'postponed', 'confirmed', 'cancelled'],
  postponed: ['new', 'no_answer', 'postponed', 'confirmed', 'cancelled'],
  confirmed: ['cancelled'],
  cancelled: ['new'],
  fake: ['new'],
  dispatched: ['delivered', 'returned'],
};
const MOVE_ACTION = { no_answer: 'no_answer', postponed: 'postpone', confirmed: 'confirm', cancelled: 'cancel', delivered: 'delivered', returned: 'returned' };
// Back to "new": undoing no answer / postponed resets the attempts; a cancelled order is reopened.
const moveAction = (from, to) => (to === 'new' ? (['no_answer', 'postponed'].includes(from) ? 'reset' : 'reopen') : MOVE_ACTION[to]);

const ICONS = {
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  send: '<path d="M4 12l16-8-6 16-2-7z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/>',
  truck: '<path d="M2 6h11v10H2zM13 10h4l4 4v2h-8z"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  sheet: '<path d="M6 2h9l5 5v15H6zM14 2v6h6M9 12h8M9 16h8M12 10v8"/>',
  web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  cart: '<path d="M3 4h2l2 11h11l2-8H6"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/>',
  hand: '<path d="M4 20h16M6 16l9-9 3 3-9 9H6z"/>',
};
const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
const SOURCE_ICON = { sheet: 'sheet', abandoned: 'cart', landing: 'web', manual: 'hand' };

function statusCell(o) {
  const moves = STATUS_MOVES[o.status];
  if (!moves) return `<span class="pill ${o.status}">${STATUS_LABELS[o.status] || o.status}</span>`;
  const opts = [o.status, ...moves.filter((s) => s !== o.status)];
  return `<select class="pill ${o.status}" data-move>${opts.map((s) =>
    `<option value="${s}" ${s === o.status ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}</select>`;
}

function orderRow(o, products, companies, stores) {
  const edit = EDITABLE.includes(o.status);
  const text = (field, value, attrs = '') => (edit
    ? `<input class="cell" data-field="${field}" value="${esc(value ?? '')}" ${attrs}>`
    : `<span>${esc(value ?? '')}</span>`);
  const num = (field, value, w = 64) => (edit
    ? `<input class="cell num" data-field="${field}" value="${esc(value ?? '')}" type="number" min="0" style="width:${w}px">`
    : `${Math.round(Number(value) || 0)}`);
  const pick = (field, list, selected, empty = '', cls = '') => `<select class="cell drop ${cls}" data-field="${field}">
    ${empty ? `<option value="">${empty}</option>` : ''}
    ${list.map(([v, l]) => `<option value="${v}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const reference = o.external_id && !o.external_id.startsWith('row-') ? o.external_id : o.reference;
  return `<tr class="st-${o.status}" data-id="${o.id}">
    <td><input type="checkbox" data-check></td>
    <td><span class="src ${o.source}" title="${SOURCE_LABELS[o.source] || o.source}">${icon(SOURCE_ICON[o.source] || 'hand')}</span></td>
    <td class="nowrap">${esc(reference)}${o.source === 'abandoned' ? ' <span class="tag">Abando</span>' : ''}${o.duplicate_of ? ' <span class="tag warn">مكررة؟</span>' : ''}</td>
    <td class="nowrap muted">${esc(fmtDate(o.created_at))}</td>
    <td>${text('customer_name', o.customer_name, 'style="width:130px"')}</td>
    <td class="nowrap"><a class="wa" href="${whatsapp(o.phone)}" target="_blank" rel="noopener" title="WhatsApp">●</a>
      ${text('phone', o.phone, 'style="width:100px" dir="ltr"')}</td>
    <td class="nowrap"><span class="calls ${o.call_attempts ? 'has' : ''}" title="محاولات الاتصال">${o.call_attempts || 0} ✆</span>
      ${['new', 'no_answer', 'postponed'].includes(o.status) ? '<button class="plus" data-attempt title="ما ردش: زيد محاولة">+1</button>' : ''}</td>
    <td class="nowrap">${statusCell(o)}${o.dispatch_error ? `<div class="err" title="${esc(o.dispatch_error)}">خطأ إرسال</div>` : ''}</td>
    <td>${text('address', o.address, 'style="width:120px"')}</td>
    <td>${state.user.role === 'admin' && edit
      ? `<select class="cell drop ${o.store_id ? '' : 'missing'}" data-store title="البوتيك تاع المنتج: يتبدل للمنتج كامل">
          <option value="">— بلا بوتيك</option>
          ${stores.map((s) => `<option value="${s.id}" ${s.id === o.store_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`
      : esc(o.store_name || '—')}</td>
    <td>${edit ? pick('stop_desk', [['0', 'المنزل'], ['1', 'مكتب']], o.stop_desk ? '1' : '0') : o.stop_desk ? 'مكتب' : 'المنزل'}</td>
    <td>${edit ? pick('wilaya_code', state.meta.wilayas.map((w) => [w.code, `${w.code} - ${w.name_fr}`]), o.wilaya_code, '', 'w') : esc(wilaya(o.wilaya_code))}</td>
    <td>${text('commune', o.commune, 'style="width:110px"')}</td>
    <td>${edit && !o.stock_reserved
      ? pick('product_id', products.filter((p) => p.active || p.id === o.product_id).map((p) => [p.id, p.name]), o.product_id, '', 'p')
      : esc(o.product_name)}</td>
    <td class="num">${num('unit_price', o.unit_price)}</td>
    <td class="num">${edit ? `<input class="cell num" data-field="quantity" value="${o.quantity}" type="number" min="1" style="width:44px">` : o.quantity}</td>
    <td class="num">${num('delivery_fee', o.delivery_fee, 56)}</td>
    <td class="num"><b>${Math.round(Number(o.total) || 0)}</b></td>
    <td class="details">${edit
      ? `<textarea class="cell" data-field="notes" rows="1" placeholder="—">${esc(o.notes || '')}</textarea>`
      : esc(o.notes || '')}</td>
    <td>${edit ? pick('company_id', companies.map((c) => [c.id, c.name]), o.company_id, '— بلا شركة', o.company_id ? '' : 'missing') : esc(o.company_name || '')}
      ${o.tracking ? `<div class="muted" dir="ltr">${esc(o.tracking)}</div>` : ''}</td>
    <td class="muted">${esc(o.confirmed_by || '')}</td>
    <td class="acts nowrap">
      ${state.user.role === 'admin' && !['dispatched', 'delivered', 'returned'].includes(o.status) ? `<button data-delete title="حذف">${icon('trash', 'red')}</button>` : ''}
      <button data-open title="السجل">${icon('clock')}</button>
      ${o.status === 'confirmed' ? `<button data-dispatch title="إرسال لشركة التوصيل" class="dark">${icon('send')}</button>` : ''}
      ${edit ? `<button data-edit title="تعديل كامل">${icon('edit', 'green')}</button>` : ''}
      ${o.status === 'confirmed' || (o.status === 'dispatched' && state.user.role === 'admin')
        ? `<button data-back title="رجّعها لتأكيد الطلبيات${o.status === 'dispatched' ? ' (الطرد يتحذف عند شركة التوصيل)' : ''}">${icon('truck', 'red')}</button>` : ''}
      ${o.tracking ? `<button data-open title="التراكينغ: ${esc(o.tracking)}">${icon('truck', 'green')}</button>` : ''}
    </td></tr>`;
}

// Every change in the table is saved right away, then only that row is redrawn.
function bindOrderTable(table, rows, products, companies, stores) {
  const byId = new Map(rows.map((o) => [o.id, o]));
  const redraw = (tr, o) => {
    byId.set(o.id, o);
    tr.outerHTML = orderRow(o, products, companies, stores);
  };
  const save = async (tr, request) => {
    const id = Number(tr.dataset.id);
    const old = byId.get(id);
    tr.classList.add('saving');
    try {
      const r = await request(id);
      const confirmed_by = r.status === 'confirmed' && old.status !== 'confirmed' ? state.user.username : old.confirmed_by;
      redraw(tr, { ...old, ...r, confirmed_by });
      if (r.dispatch_error) toast(`مؤكدة، بصح الإرسال فشل: ${r.dispatch_error}`, true);
      else if (r.status === 'dispatched' && old.status !== 'dispatched') toast(`تبعثت لـ ${r.company_name}${r.tracking ? ` (${r.tracking})` : ''}`);
      else toast('تم الحفظ');
    } catch (err) {
      redraw(tr, old);
      toast(err.message, true);
    }
  };

  table.addEventListener('change', (e) => {
    const el = e.target;
    const tr = el.closest('tr[data-id]');
    if (!tr || el.matches('[data-check]')) return;
    if (el.matches('[data-store]')) {
      const o = byId.get(Number(tr.dataset.id));
      const name = el.selectedOptions[0].textContent.trim();
      if (!confirm(`المنتج "${o.product_name}" يولي في البوتيك ${name}، والطلبيات تاعو اللي مازال ما تبعثوش يتبعوه. نكمل؟`)) return redraw(tr, o);
      return guard(async () => {
        const r = await api('PUT', `/products/${o.product_id}/store`, { store_id: el.value || null });
        toast(`تم: ${r.orders} طلبية تبدلت شركة التوصيل تاعها`);
        router();
      })();
    }
    if (el.matches('[data-move]')) {
      const action = moveAction(byId.get(Number(tr.dataset.id)).status, el.value);
      if (action === 'cancel' && !confirm('تأكيد إلغاء الطلبية؟')) return redraw(tr, byId.get(Number(tr.dataset.id)));
      return save(tr, (id) => api('POST', `/orders/${id}/action`, { action }));
    }
    const field = el.dataset.field;
    if (!field) return;
    let value = el.value;
    if (field === 'stop_desk') value = value === '1';
    if (field === 'company_id') value = value ? Number(value) : null;
    if (['quantity', 'unit_price', 'delivery_fee', 'wilaya_code', 'product_id'].includes(field)) {
      if (value === '') return redraw(tr, byId.get(Number(tr.dataset.id)));
      value = Number(value);
    }
    save(tr, (id) => api('PUT', `/orders/${id}`, { [field]: value }));
  });

  table.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = Number(tr.dataset.id);
    if (e.target.closest('[data-attempt]')) return save(tr, () => api('POST', `/orders/${id}/action`, { action: 'no_answer' }));
    if (e.target.closest('[data-edit]')) return orderForm(byId.get(id), products);
    if (e.target.closest('[data-dispatch]')) return save(tr, () => api('POST', `/orders/${id}/dispatch`, {}));
    if (e.target.closest('[data-back]')) {
      const o = byId.get(id);
      const ask = o.status === 'dispatched'
        ? `الطرد ${o.tracking || ''} يتحذف عند ${o.company_name || 'شركة التوصيل'} والطلبية ترجع لتأكيد الطلبيات. نكمل؟`
        : 'الطلبية ترجع لتأكيد الطلبيات (جديدة) والستوك يرجع. نكمل؟';
      if (!confirm(ask)) return;
      return guard(async () => {
        await api('POST', `/orders/${id}/back`, {});
        tr.remove();
        toast('رجعت لتأكيد الطلبيات');
      })();
    }
    if (e.target.closest('[data-open]')) return openOrder(id);
    if (e.target.closest('[data-delete]')) {
      if (!confirm('حذف الطلبية نهائياً؟')) return;
      return guard(async () => {
        await api('DELETE', `/orders/${id}`);
        tr.remove();
        toast('تحذفت');
      })();
    }
  });
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
      <div><div class="muted">الهاتف</div><a href="tel:${esc(o.phone)}" dir="ltr">${esc(o.phone)}</a> <a href="${whatsapp(o.phone)}" target="_blank" rel="noopener">💬 WhatsApp</a>${o.phone2 ? ` / <a href="tel:${esc(o.phone2)}" dir="ltr">${esc(o.phone2)}</a>` : ''}</div>
      <div><div class="muted">الولاية / البلدية</div>${wilaya(o.wilaya_code)} / ${esc(o.commune || '—')}</div>
      <div><div class="muted">العنوان</div>${esc(o.address || '—')} ${o.stop_desk ? '<span class="badge">مكتب</span>' : ''}</div>
      <div><div class="muted">المنتج</div>${esc(o.product_name)} × ${o.quantity}${o.store_name ? ` <span class="muted">(${esc(o.store_name)})</span>` : ''}</div>
      <div><div class="muted">المجموع</div>${money(o.unit_price * o.quantity)} + توصيل ${money(o.delivery_fee)} = <b>${money(o.total)}</b></div>
      <div><div class="muted">شركة التوصيل</div>${esc(o.company_name || 'غير محددة')} ${esc(o.tracking || '')}</div>
      <div><div class="muted">المصدر</div>${SOURCE_LABELS[o.source] || o.source} ${o.utm_campaign ? `· ${esc(o.utm_campaign)}` : ''}</div>
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
      ${['no_answer', 'postponed'].includes(o.status) ? '<button class="btn" data-action="reset">رجعها جديدة</button>' : ''}
      ${o.status === 'cancelled' ? '<button class="btn" data-action="reopen">إعادة فتح</button>' : ''}
      ${['new', 'no_answer', 'postponed', 'confirmed'].includes(o.status) ? '<button class="btn" data-edit>تعديل</button>' : ''}
      <button class="btn" data-close>إغلاق</button>
    </div>
    <h4>السجل</h4>
    <ul class="timeline">${o.events.map((e) =>
      `<li><span class="muted">${esc(fmtDate(e.created_at))}</span> · ${esc(EVENT_LABELS[e.type] || e.type)} ${e.message ? `— ${esc(e.message)}` : ''} ${e.username ? `<span class="muted">(${esc(e.username)})</span>` : ''}</li>`).join('')}</ul>`);

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
      ${order?.stock_reserved ? '' : `<label>المنتج<select name="product_id" required>${products.filter((p) => p.active || p.id === o.product_id)
        .map((p) => `<option value="${p.id}" ${p.id === o.product_id ? 'selected' : ''}>${esc(p.name)} — ${money(p.price)}</option>`).join('')}</select></label>`}
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
      // New product without a hand-typed price: take the new product's price.
      if (f.product_id && Number(f.product_id) !== o.product_id && Number(f.unit_price) === o.unit_price) delete f.unit_price;
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

// Reads each store's parcels page by page (each page is one short request),
// then links every product to the store that ships it.
async function linkStoresDialog(stores) {
  const box = modal.open(`<h3>ربط المنتجات بالفروع</h3>
    <p class="muted">نقراو الطرود تاع آخر 60 يوم عند شركة التوصيل تاع كل فرع. ما نبعثو والو ما نبدلو والو عندهم.</p>
    <ul class="timeline" id="link-log"></ul><div class="actions"><button class="btn" data-close>إغلاق</button></div>`);
  const log = (html) => box.querySelector('#link-log').insertAdjacentHTML('beforeend', `<li>${html}</li>`);
  const texts = {};
  for (const s of stores) {
    if (!s.company_id) {
      log(`${esc(s.name)}: <span class="muted">ما عندهاش شركة توصيل</span>`);
      continue;
    }
    texts[s.id] = [];
    let page = 1;
    let last = 1;
    try {
      do {
        const r = await api('POST', '/branches/scan', { store_id: s.id, page });
        texts[s.id].push(...r.texts);
        last = Math.min(r.last_page, 15);
        page += 1;
      } while (page <= last);
      log(`${esc(s.name)}: ${texts[s.id].length} طرد`);
    } catch (err) {
      log(`<span class="neg">${esc(err.message)}</span>`);
    }
  }
  const r = await api('POST', '/branches/apply', { texts });
  log(`<b>${r.linked.length} منتج تربط</b>${r.kept ? `، ${r.kept} كانو مربوطين صح` : ''}`);
  r.linked.forEach((l) => log(`${esc(l.product)} ← ${esc(l.to)}${l.from ? ` <span class="muted">(كان ${esc(l.from)})</span>` : ''}${l.orders ? ` · ${l.orders} طلبية` : ''}`));
  if (r.unmatched.length) log(`<span class="neg">ما لقيناش الفرع تاع:</span> ${r.unmatched.map(esc).join('، ')}`);
  box.querySelector('[data-close]').onclick = () => { modal.close(); router(); };
}

// ---------- products ----------
async function productsPage() {
  const [products, stores, companies] = await Promise.all([api('GET', '/products'), api('GET', '/stores'), api('GET', '/delivery/companies')]);
  const isAdmin = state.user.role === 'admin';
  const select = (field, list, selected, empty) => `<select class="cell" data-product-field="${field}"><option value="">${empty}</option>
    ${list.map((x) => `<option value="${x.id}" ${x.id === selected ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`;
  const main = shell(`
    <h2>المنتجات</h2>
    ${isAdmin ? `<div class="bar"><button class="btn primary" id="add">+ منتج جديد</button>
      <button class="btn" id="link-stores" title="يقرا الطرود اللي بعثها كل فرع عند شركة التوصيل تاعو، ويعرف منها كل منتج لأنهي فرع">ربط المنتجات بالفروع تلقائياً</button></div>` : ''}
    <div class="table-wrap"><table>
      <tr><th>المنتج</th><th>البوتيك</th><th>شركة التوصيل</th><th>السعر</th><th>سعر الشراء</th><th>المخزون</th><th>صفحة الهبوط</th><th>طلبيات</th><th></th></tr>
      ${products.map((p) => `<tr data-product="${p.id}">
        <td>${esc(p.name)} ${p.sku ? `<span class="muted">${esc(p.sku)}</span>` : ''} ${p.active ? '' : '<span class="badge">موقف</span>'}</td>
        <td>${isAdmin ? select('store_id', stores, p.store_id, '— بلا بوتيك —') : esc(p.store_name || '—')}</td>
        <td>${isAdmin ? select('company_id', companies, p.company_id, `نفس البوتيك${p.company_from_store && p.company_name ? ` (${esc(p.company_name)})` : ''}`)
          : esc(p.company_name || '—')}</td>
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

  // Store and delivery company save right away; the product's open orders follow.
  main.querySelectorAll('[data-product-field]').forEach((el) => (el.onchange = guard(async () => {
    const id = el.closest('tr').dataset.product;
    const r = await api('PUT', `/products/${id}/store`, { [el.dataset.productField]: el.value || null });
    toast(r.orders ? `تم الحفظ، ${r.orders} طلبية تبعتو` : 'تم الحفظ');
    router();
  })));
  const byId = (id) => products.find((p) => p.id === Number(id));
  const add = main.querySelector('#add');
  if (add) add.onclick = () => productForm(null, stores);
  const link = main.querySelector('#link-stores');
  if (link) link.onclick = guard(() => linkStoresDialog(stores));
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
      <label>دوسي الكرياتيف في الدرايف (فيديوهات femme و homme)<input name="ad_creative_folder" value="${esc(x.ad_creative_folder)}" placeholder="https://drive.google.com/drive/folders/..." dir="ltr"></label>
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
      ${moves.map((m) => `<tr><td class="muted">${esc(fmtDate(m.created_at))}</td>
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
    <p class="muted">كل بوتيك عندها شركة توصيل، وعندها حسابها الخاص (التوكن) عند كل شركة تخدم معاها. باش تزيد توكن لبوتيك كاينة اضغط "تعديل" قدامها (ماشي "+ بوتيك"). المنتجات تتربط بالبوتيك والشركة من صفحة "المنتجات".</p>
    <div class="bar"><button class="btn primary" id="add">+ بوتيك</button></div>
    <div class="table-wrap"><table>
      <tr><th>البوتيك</th><th>شركة التوصيل</th><th>الحسابات (التوكن)</th><th>استثناءات حسب الولاية</th><th>منتجات</th><th></th></tr>
      ${stores.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.company_name || '— (حسب الولاية)')}</td>
        <td class="muted">${s.accounts.filter((a) => a.has_token).map((a) => `${esc(a.company_name)} ✓`).join('، ') || '<span class="neg">ما كاين حتى توكن</span>'}</td>
        <td class="muted">${s.routes.map((r) => `${wilaya(r.wilaya_code)} ← ${esc(r.company_name)}`).join('، ') || '—'}</td>
        <td class="num">${s.products_count}</td>
        <td><button class="btn small" data-edit="${s.id}">تعديل</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">زيد البوتيك الأولى</td></tr>'}
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
      <label>شركة التوصيل تاع البوتيك<select name="company_id"><option value="">— حسب الولاية (صفحة التوصيل)</option>${companyOptions(x.company_id)}</select></label>
      <div class="muted">الحساب تاع البوتيك عند كل شركة (فارغ = ما يتبدلش)</div>
      ${companies.map((c) => {
        const a = (x.accounts || []).find((y) => y.company_id === c.id) || {};
        const myEcom = /ecom-dz/.test(c.base_url || '');
        return `<div class="grid2 account-row" data-company="${c.id}">
          <label>${esc(c.name)}: التوكن<input name="api_token" dir="ltr" autocomplete="off" placeholder="${a.has_token ? 'محطوط ✓' : ''}"></label>
          ${myEcom ? `<label>${esc(c.name)}: key<input name="api_key" dir="ltr" autocomplete="off" placeholder="${a.has_key ? 'محطوط ✓' : ''}"></label>` : '<div></div>'}
        </div>`;
      }).join('')}
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
      // The first company select is the store's own; the exception rows have more.
      company_id: e.target.querySelector('select[name=company_id]').value || null,
      accounts: [...box.querySelectorAll('.account-row')].map((row) => ({
        company_id: Number(row.dataset.company),
        api_token: row.querySelector('[name=api_token]').value.trim() || null,
        api_key: row.querySelector('[name=api_key]')?.value.trim() || null,
      })),
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

// ---------- Google Sheets ----------
const SHEET_FIELD_LABELS = {
  customer_name: 'الاسم الكامل *', phone: 'رقم الهاتف *', product_name: 'اسم المنتج *', external_id: 'رقم الطلبية',
  address: 'العنوان', delivery_type: 'نوعية التوصيل', wilaya: 'الولاية *', commune: 'البلدية',
  subtotal: 'سعر المنتج', quantity: 'الكمية', shipping_price: 'سعر التوصيل', discount: 'تخفيض',
  total: 'السعر الكلي', notes: 'ملاحظة', phone2: 'هاتف 02', sku: 'SKU', variant: 'المقاس واللون',
  created_at: 'تاريخ الطلبية',
};

async function sheetsPage() {
  const [sheets, stores] = await Promise.all([api('GET', '/sheets'), api('GET', '/stores')]);
  const main = shell(`
    <h2>الشيتات</h2>
    <p class="muted">الطلبيات تدخل وحدها من Google Sheets (كيما LightFunnels) كل 5 دقايق. الشيت لازم يكون مشارك: Partager ← "Tous les utilisateurs disposant du lien" ← Lecteur. الطلبيات المتروكة (Abandoned) تدخل للتأكيد بعلامة "متروكة"، والطلبيات من شيت وهمي تدخل بحالة "وهمية" وما تتبعثش للتوصيل.</p>
    <div class="bar"><button class="btn primary" id="add">+ شيت</button></div>
    <div class="table-wrap"><table>
      <tr><th>الشيت</th><th>البوتيك</th><th>النوع</th><th>دخلو</th><th>آخر مرة</th><th>أخطاء</th><th></th></tr>
      ${sheets.map((g) => `<tr><td>${esc(g.name)}${g.active ? '' : ' <span class="badge">متوقف</span>'}</td>
        <td>${esc(g.store_name || '—')}</td>
        <td>${g.kind === 'fake' ? badge('fake') : g.kind === 'abandoned' ? '<span class="badge warn">متروكة</span>' : 'حقيقية'}</td>
        <td class="num">${g.imported_count}</td>
        <td class="muted">${fmtDate(g.last_sync_at) || '—'}<br>السطر ${g.last_row || g.start_row - 1}</td>
        <td class="muted" style="white-space:pre-line;color:var(--danger)">${esc(g.last_error || '')}</td>
        <td class="actions"><button class="btn small" data-sync="${g.id}">جيب دوكا</button>
          <button class="btn small" data-edit="${g.id}">تعديل</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">زيد الشيت الأول</td></tr>'}
    </table></div>`);
  main.querySelector('#add').onclick = () => sheetForm(null, stores);
  main.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => sheetForm(sheets.find((g) => g.id === Number(b.dataset.edit)), stores)));
  main.querySelectorAll('[data-sync]').forEach((b) => (b.onclick = guard(async () => {
    b.disabled = true;
    const r = await api('POST', `/sheets/${b.dataset.sync}/sync`);
    toast(`دخلو ${r.imported} طلبية${r.errors.length ? `، ${r.errors.length} أخطاء` : ''}`, r.errors.length > 0);
    router();
  })));
}

function sheetForm(sheet, stores) {
  const x = sheet || { kind: 'real', mapping: {}, start_row: 2, active: true };
  const box = modal.open(`
    <h3>${sheet ? `تعديل ${esc(sheet.name)}` : 'شيت جديد'}</h3>
    <form class="stack" id="sheet-form">
      <div class="grid2">
        <label>الاسم<input name="name" value="${esc(x.name)}" placeholder="yacine boutique" required></label>
        <label>البوتيك<select name="store_id"><option value="">—</option>${stores.map((s) =>
          `<option value="${s.id}" ${s.id === x.store_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label>النوع<select name="kind"><option value="real">طلبيات حقيقية</option>
          <option value="abandoned" ${x.kind === 'abandoned' ? 'selected' : ''}>طلبيات متروكة (Abandoned): تروح للتأكيد</option>
          <option value="fake" ${x.kind === 'fake' ? 'selected' : ''}>طلبيات وهمية: للإحصائيات برك</option></select></label>
        <label>الحالة<select name="active"><option value="true">يخدم</option>
          <option value="false" ${x.active ? '' : 'selected'}>متوقف</option></select></label>
      </div>
      <label>رابط الشيت<div class="actions"><input name="sheet_url" value="${esc(x.sheet_url)}" style="flex:1" dir="ltr" required>
        <button class="btn" type="button" id="read">قرا الأعمدة</button></div></label>
      <div id="mapping" class="muted">لصق الرابط واضغط "قرا الأعمدة".</div>
      <div class="actions">
        <button class="btn primary">حفظ</button>
        ${sheet ? '<button class="btn danger" type="button" data-delete>حذف</button>' : ''}
        <button class="btn" type="button" data-close>إلغاء</button>
      </div>
    </form>`);
  const form = box.querySelector('#sheet-form');
  const mappingBox = box.querySelector('#mapping');
  const renderMapping = (headers, mapping, startRow, rows) => {
    const options = (selected) => `<option value="">— ما كاش</option>${headers.map((h) =>
      `<option ${h === selected ? 'selected' : ''}>${esc(h)}</option>`).join('')}`;
    mappingBox.className = 'stack';
    mappingBox.innerHTML = `
      <div class="grid2">${Object.entries(SHEET_FIELD_LABELS).map(([f, label]) =>
        `<label>${label}<select data-field="${f}">${options(mapping[f])}</select></label>`).join('')}</div>
      <label>البداية من السطر<input name="start_row" type="number" min="2" value="${startRow}"></label>
      ${rows ? `<div class="muted">الشيت فيه ${rows - 1} طلبية. باش تدخل غير الطلبيات الجداد خلي ${rows + 1}، ولا نقص الرقم باش تدخل القدام.</div>` : ''}`;
  };
  const read = guard(async () => {
    const r = await api('POST', '/sheets/preview', { sheet_url: form.sheet_url.value });
    const mapping = sheet ? { ...r.mapping, ...sheet.mapping } : r.mapping;
    renderMapping(r.headers, mapping, sheet ? sheet.start_row : r.next_row, r.rows);
  });
  box.querySelector('#read').onclick = read;
  if (sheet) {
    renderMapping([...new Set(Object.values(sheet.mapping))], sheet.mapping, sheet.start_row, 0);
    read();
  }
  const del = box.querySelector('[data-delete]');
  if (del) {
    del.onclick = guard(async () => {
      if (!confirm('حذف الشيت؟ الطلبيات اللي دخلت تبقى.')) return;
      await api('DELETE', `/sheets/${sheet.id}`);
      modal.close();
      router();
    });
  }
  form.onsubmit = guard(async (e) => {
    e.preventDefault();
    const selects = [...mappingBox.querySelectorAll('[data-field]')];
    if (!selects.length) return toast('اضغط "قرا الأعمدة" الأول', true);
    const body = {
      name: form.elements.name.value,
      store_id: form.store_id.value || null,
      kind: form.kind.value,
      active: form.active.value === 'true',
      sheet_url: form.sheet_url.value,
      start_row: form.start_row.value,
      mapping: Object.fromEntries(selects.map((sel) => [sel.dataset.field, sel.value]).filter(([, v]) => v)),
    };
    await (sheet ? api('PUT', `/sheets/${sheet.id}`, body) : api('POST', '/sheets', body));
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
      ${users.map((u) => `<tr><td>${esc(u.username)}</td><td>${u.role === 'admin' ? 'مدير' : 'مؤكدة'}</td><td class="muted">${esc(fmtDate(u.created_at))}</td>
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
