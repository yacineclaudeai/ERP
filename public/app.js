// Admin interface: a small hash-routed single page app, no build step.

const STATUS_LABELS = {
  new: 'جديدة', no_answer: 'فاشلة', postponed: 'مؤجلة', confirmed: 'مؤكدة', cancelled: 'ملغاة',
  dispatched: 'عند التوصيل', delivered: 'مستلمة', returned: 'روتور', fake: 'وهمية',
};
// "ما ردش" orders are shown like Ecotrack: الفاشلة 1 … الفاشلة 5 (the failed calls).
const FAILED = [1, 2, 3, 4, 5].map((n) => [`failed_${n}`, `الفاشلة ${n}`]);
const failedLabel = (o) => `الفاشلة ${Math.max(1, o.call_attempts || 0)}`;
const EVENT_LABELS = {
  created: 'تسجلت', duplicate: 'مكررة؟', no_answer: 'فاشلة (ما ردش)', postponed: 'تأجلت', confirmed: 'تأكدت',
  cancelled: 'تلغات', reopened: 'تعاودت تفتحت', dispatched: 'تبعثت للتوصيل', dispatch_failed: 'فشل الإرسال',
  delivered: 'تستلمت', returned: 'روتور', return_received: 'الروتور وصل', edited: 'تعدلت',
  assigned: 'تعطات لمؤكدة', transferred: 'تحولت لمؤكدة أخرى',
};
const SOURCE_LABELS = { landing: 'صفحة الهبوط', sheet: 'شيت', lightfunnels: 'LightFunnels', abandoned: 'متروكة', manual: 'يدوي' };
const SOURCE_ICONS = { landing: '🌐', sheet: '📗', abandoned: '🛒', manual: '✍️' };
// wa.me wants the number in international form, without the leading 0.
const whatsapp = (phone) => `https://wa.me/213${String(phone).replace(/^0/, '')}`;
const PROVIDER_LABELS = { ecotrack: 'Ecotrack (API)', myecom: 'My Ecom (API)', sandbox: 'تجربة (بدون API)', manual: 'يدوي (بدون API)' };

const state = { user: null, meta: null };
const app = document.getElementById('app');

// ---------- helpers ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => `${Math.round(Number(v) || 0).toLocaleString('fr-DZ')} دج`;
const pct = (v) => (v == null ? '—' : `${v}%`);
const badge = (s) => `<span class="badge ${s}">${STATUS_LABELS[s] || s}</span>`;
const wilaya = (code) => {
  const w = state.meta?.wilayas.find((x) => x.code === Number(code));
  return w ? `${w.code} - ${w.name_ar}` : Number(code) === 0 ? 'اختر الولاية' : code;
};
// Wilaya 0 = an abandoned checkout where the customer didn't choose one yet.
const wilayaOptions = (selected) => (Number(selected) === 0 ? '<option value="0" selected>اختر الولاية</option>' : '') + state.meta.wilayas
  .map((w) => `<option value="${w.code}" ${Number(selected) === w.code ? 'selected' : ''}>${w.code} - ${w.name_ar} / ${w.name_fr}</option>`).join('');
const today = () => new Date().toISOString().slice(0, 10);
// Timestamps come from the server in UTC; show them in Algeria time.
const fmtDate = (v) => (v ? new Date(v).toLocaleString('fr-FR', { timeZone: 'Africa/Algiers', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '');

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
// [page, label, permission needed]; 'admin' means admins only.
const NAV = [
  ['#/', 'لوحة التحكم', 'dashboard'],
  ['#/stats', 'الإحصائيات', 'stats'],
  ['#/orders', 'تأكيد الطلبيات', 'confirm'],
  ['#/tracking', 'تتبع الطلبيات', 'tracking'],
  ['#/products', 'المنتجات', 'products'],
  ['#/accounting', 'الفايدة لكل منتج', 'accounting'],
  ['#/stores', 'البوتيكات', 'stores'],
  ['#/sheets', 'الشيتات', 'sheets'],
  ['#/delivery', 'التوصيل', 'delivery'],
  ['#/ads', 'مصاريف الإشهار', 'ads'],
  ['#/users', 'المستخدمين', 'admin'],
];
const isAdminUser = () => state.user?.role === 'admin';
const can = (perm) => isAdminUser() || (perm !== 'admin' && Boolean(state.user?.permissions?.includes(perm)));
const roleLabel = (u) => (u.role === 'admin' ? 'مدير' : 'عامل');

function shell(content) {
  const route = location.hash.split('?')[0] || '#/';
  app.innerHTML = `
    <div class="layout">
      <nav class="side">
        <h1>ERP</h1>
        ${NAV.filter(([, , perm]) => can(perm))
          .map(([href, label]) => `<a href="${href}" class="${route === href ? 'active' : ''}">${label}</a>`).join('')}
        <a href="#" id="logout">خروج</a>
        <div class="who">${esc(state.user.username)} · ${roleLabel(state.user)}</div>
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
  '#/stats': statsPage,
  '#/orders': () => ordersPage('confirm'),
  '#/tracking': () => ordersPage('tracking'),
  '#/products': productsPage,
  '#/accounting': accountingPage,
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
  // A page this account may not open sends it to its first allowed page.
  const allowed = NAV.filter(([, , perm]) => can(perm));
  const entry = NAV.find(([href]) => href === route) || NAV[0];
  if (!can(entry[2])) {
    if (!allowed.length) return (app.innerHTML = '<div class="card login"><h2>ما عندك حتى صفحة</h2><p>كلم المدير باش يعطيك الصلاحيات.</p></div>');
    if (allowed[0][0] !== route) return (location.hash = allowed[0][0]);
  }
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

// ---------- statistics (Ecotrack style) ----------
const CHART_COLORS = { green: '#22c55e', red: '#ef4444', orange: '#f59e0b', blue: '#3b82f6', grey: '#9ca3af', purple: '#8b5cf6' };

// Ring chart: [{ label, value, color }].
function donut(parts) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return '<p class="muted">ما كاين والو في هاد الفترة</p>';
  const r = 70, c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = parts.filter((p) => p.value).map((p) => {
    const len = (p.value / total) * c;
    const arc = `<circle r="${r}" cx="100" cy="100" fill="none" stroke="${p.color}" stroke-width="36"
      stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}"><title>${esc(p.label)}: ${p.value}</title></circle>`;
    offset += len;
    return arc;
  }).join('');
  return `<div class="donut"><svg viewBox="0 0 200 200" style="transform:rotate(-90deg)">${arcs}</svg>
    <div class="legend">${parts.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.label)}: <b>${p.value}</b> (${Math.round((p.value / total) * 100)}%)</span>`).join('')}</div></div>`;
}

// Rate per day, 0 to 100%.
function rateLine(days, label) {
  const pts = days.filter((d) => d.rate != null);
  if (pts.length < 2) return '<p class="muted">لازم زوج أيام على الأقل باش يخرج المنحنى</p>';
  const W = 600, H = 220, L = 34, B = 30;
  const x = (i) => L + (i * (W - L - 10)) / (pts.length - 1);
  const y = (v) => 10 + ((100 - v) * (H - B - 10)) / 100;
  const grid = [0, 25, 50, 75, 100].map((v) => `<line x1="${L}" x2="${W - 10}" y1="${y(v)}" y2="${y(v)}" stroke="#ddd"/><text x="${L - 4}" y="${y(v) + 4}" font-size="10" text-anchor="end">${v}%</text>`).join('');
  const step = Math.ceil(pts.length / 8);
  const labels = pts.map((d, i) => (i % step ? '' : `<text x="${x(i)}" y="${H - 10}" font-size="10" text-anchor="middle">${String(d.day).slice(5, 10)}</text>`)).join('');
  const line = pts.map((d, i) => `${x(i)},${y(d.rate)}`).join(' ');
  const dots = pts.map((d, i) => `<circle cx="${x(i)}" cy="${y(d.rate)}" r="3" fill="${CHART_COLORS.green}"><title>${String(d.day).slice(0, 10)}: ${d.rate}%</title></circle>`).join('');
  return `<div class="muted">${esc(label)}</div><svg viewBox="0 0 ${W} ${H}" class="line-chart" dir="ltr">${grid}${labels}
    <polyline points="${line}" fill="none" stroke="${CHART_COLORS.green}" stroke-width="2.5"/>${dots}</svg>`;
}

const statCard = (label, value, cls = '') => `<div class="stat-card ${cls}"><div class="l">${esc(label)}</div><div class="v">${value}</div></div>`;
const rateBar = (rate) => `<div class="rate-bar"><div style="width:${rate ?? 0}%"></div><span>${pct(rate)}</span></div>`;

const PERIODS = [['all', 'كل الوقت'], ['today', 'اليوم'], ['yesterday', 'البارح'], ['week', 'أسبوع'], ['month', 'شهر']];
function periodRange(period) {
  // Days in Algeria time, like the server counts them.
  const day = (n) => new Date(Date.now() - n * 86400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Algiers' });
  return { today: [day(0), day(0)], yesterday: [day(1), day(1)], week: [day(6), day(0)], month: [day(29), day(0)] }[period] || ['', ''];
}

async function statsPage() {
  const q = Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
  const tab = q.tab === 'delivery' ? 'delivery' : 'confirmation';
  const period = q.period || (q.from || q.to ? 'custom' : 'month');
  const [from, to] = period === 'custom' ? [q.from || '', q.to || ''] : periodRange(period);
  const filters = { from, to, store_id: q.store_id || '', product_id: q.product_id || '', user_id: q.user_id || '' };
  const [s, stores, products] = await Promise.all([
    api('GET', `/stats/${tab}?${new URLSearchParams(filters)}`), api('GET', '/stores'), api('GET', '/products'),
  ]);
  const go = (patch) => {
    const next = { tab, period, ...filters, ...patch };
    if (next.period !== 'custom') delete next.from, delete next.to;
    location.hash = `#/stats?${new URLSearchParams(Object.entries(next).filter(([, v]) => v))}`;
  };
  const options = (list, selected, empty) => `<option value="">${empty}</option>${list.map((x) =>
    `<option value="${x.id}" ${String(x.id) === String(selected) ? 'selected' : ''}>${esc(x.name || x.username)}</option>`).join('')}`;
  const team = tab === 'confirmation' ? s.team : [];

  const body = tab === 'confirmation' ? `
    <div class="card">
      <h3 class="card-title">إحصائيات التأكيد</h3>
      <div class="stat-cards">
        ${statCard('المؤكدة', s.confirmed, 'green')}
        ${statCard('الملغاة', s.cancelled, 'red')}
        ${statCard('الفاشلة (ما ردش)', s.failed, 'orange')}
        ${statCard('المعلقة (جديدة)', s.pending, 'blue')}
        ${statCard('مؤجلة', s.postponed, 'purple')}
        ${statCard('مكررة', s.duplicates, 'grey')}
      </div>
      <div class="muted">نسبة التأكيد (المؤكدة ÷ المؤكدة + الملغاة) من ${s.orders} طلبية</div>
      ${rateBar(s.rate)}
      <div class="stats-grid">
        <div class="card">${donut([
          { label: 'المؤكدة', value: s.confirmed, color: CHART_COLORS.green },
          { label: 'الملغاة', value: s.cancelled, color: CHART_COLORS.red },
          { label: 'الفاشلة', value: s.failed, color: CHART_COLORS.orange },
          { label: 'المعلقة', value: s.pending, color: CHART_COLORS.blue },
          { label: 'مؤجلة', value: s.postponed, color: CHART_COLORS.purple },
        ])}</div>
        <div class="card">${rateLine(s.daily, 'نسبة التأكيد في كل يوم')}</div>
      </div>
    </div>
    <div class="card">
      <h3 class="card-title">إحصائيات فريق التأكيد</h3>
      <div class="team-grid">${s.team.map((t) => `<div class="team-card">
        <b>${esc(t.username)}</b>
        <div>المؤكدة <b>${t.confirmed}</b></div><div>الملغاة <b>${t.cancelled}</b></div>
        <div>الفاشلة <b>${t.failed}</b></div><div>مؤجلة <b>${t.postponed}</b></div>
        ${rateBar(t.rate)}</div>`).join('') || '<p class="muted">مازال حتى واحد ما أكد في هاد الفترة</p>'}</div>
    </div>
    <div class="card"><h3 class="card-title">حسب المنتج</h3><div class="table-wrap"><table>
      <tr><th>المنتج</th><th>طلبيات</th><th>المؤكدة</th><th>الملغاة</th><th>نسبة التأكيد</th></tr>
      ${s.products.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${p.orders}</td><td class="num">${p.confirmed}</td><td class="num">${p.cancelled}</td><td class="num">${pct(p.rate)}</td></tr>`).join('')}
    </table></div></div>` : `
    <div class="card">
      <h3 class="card-title">إحصائيات التوصيل</h3>
      <div class="stat-cards">
        ${statCard('مؤكدة ما تبعثتش', s.waiting, 'blue')}
        ${statCard('عند شركة التوصيل', s.at_company, 'orange')}
        ${statCard('en livraison', s.out_for_delivery, 'purple')}
        ${statCard('تليفرات', s.delivered, 'green')}
        ${statCard('روتور في الطريق', s.returning, 'red')}
        ${statCard('روتور وصل', s.returned_back, 'grey')}
      </div>
      <div class="muted">نسبة التوصيل (تليفرات ÷ تليفرات + روتور) من ${s.shipped} طرد · المبيعات ${money(s.revenue)}</div>
      ${rateBar(s.rate)}
      <div class="stats-grid">
        <div class="card">${donut([
          { label: 'تليفرات', value: s.delivered, color: CHART_COLORS.green },
          { label: 'روتور', value: s.returned, color: CHART_COLORS.red },
          { label: 'عند الشركة', value: s.at_company, color: CHART_COLORS.orange },
          { label: 'en livraison', value: s.out_for_delivery, color: CHART_COLORS.purple },
        ])}</div>
        <div class="card">${rateLine(s.daily, 'نسبة التوصيل حسب نهار الإرسال')}</div>
      </div>
    </div>
    ${[['حسب شركة التوصيل', s.companies, (x) => esc(x.name || 'بلا شركة')], ['حسب المنتج', s.products, (x) => esc(x.name)], ['حسب الولاية', s.wilayas, (x) => wilaya(x.key)]]
      .map(([title, rows, name]) => `<div class="card"><h3 class="card-title">${title}</h3><div class="table-wrap"><table>
      <tr><th></th><th>طرود</th><th>عند التوصيل</th><th>تليفرات</th><th>روتور</th><th>نسبة التوصيل</th></tr>
      ${rows.map((x) => `<tr><td>${name(x)}</td><td class="num">${x.shipped}</td><td class="num">${x.in_progress}</td><td class="num">${x.delivered}</td><td class="num">${x.returned}</td><td class="num">${pct(x.rate)}</td></tr>`).join('')}
    </table></div></div>`).join('')}`;

  const main = shell(`
    <div class="tabs stats-tabs">
      <a class="tab ${tab === 'confirmation' ? 'active' : ''}" data-tab="confirmation">إحصائيات التأكيد</a>
      <a class="tab ${tab === 'delivery' ? 'active' : ''}" data-tab="delivery">إحصائيات التوصيل</a>
    </div>
    <div class="bar stats-filters">
      <label>البوتيك<select id="f-store">${options(stores, filters.store_id, 'كل البوتيكات')}</select></label>
      <label>المنتج<select id="f-product">${options(products.filter((p) => !filters.store_id || String(p.store_id) === filters.store_id), filters.product_id, 'كل المنتجات')}</select></label>
      ${tab === 'confirmation' ? `<label>العامل<select id="f-user">${options(team.length || !filters.user_id ? team : [{ id: filters.user_id, username: '…' }], filters.user_id, 'كل العمال')}</select></label>` : ''}
      ${PERIODS.map(([k, l]) => `<button class="btn small ${period === k ? 'primary' : ''}" data-period="${k}">${l}</button>`).join('')}
      <label>من<input type="date" id="f-from" value="${esc(from)}"></label>
      <label>إلى<input type="date" id="f-to" value="${esc(to)}"></label>
      <button class="btn small" id="f-reset">إعادة الضبط</button>
    </div>
    ${body}`);
  main.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => go({ tab: b.dataset.tab, user_id: '' })));
  main.querySelectorAll('[data-period]').forEach((b) => (b.onclick = () => go({ period: b.dataset.period })));
  main.querySelector('#f-store').onchange = (e) => go({ store_id: e.target.value, product_id: '' });
  main.querySelector('#f-product').onchange = (e) => go({ product_id: e.target.value });
  const user = main.querySelector('#f-user');
  if (user) user.onchange = (e) => go({ user_id: e.target.value });
  const dates = () => go({ period: 'custom', from: main.querySelector('#f-from').value, to: main.querySelector('#f-to').value });
  main.querySelector('#f-from').onchange = dates;
  main.querySelector('#f-to').onchange = dates;
  main.querySelector('#f-reset').onclick = () => (location.hash = `#/stats?tab=${tab}`);
}

// ---------- orders ----------
const PAGE_SIZES = [50, 100, 200, 300];
// How many orders per page, remembered in this browser.
const pageSize = () => {
  try { return PAGE_SIZES.includes(Number(localStorage.getItem('erp_page_size'))) ? Number(localStorage.getItem('erp_page_size')) : 50; } catch { return 50; }
};
const ORDER_FILTERS = ['status', 'q', 'product_id', 'store_id', 'wilaya', 'company_id', 'source', 'stop_desk', 'assigned_to', 'page'];

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
  // The admin gives confirmation orders to agents.
  const assigning = mode === 'confirm' && can('confirm.assign');
  const [list, products, stats, stores, companies, team] = await Promise.all([
    api('GET', `/orders?${new URLSearchParams({ ...query, status: f.status, limit: pageSize(), offset: (page - 1) * pageSize() })}`),
    api('GET', '/products'),
    api('GET', '/orders/counts'),
    api('GET', '/stores'),
    api('GET', '/delivery/companies'),
    assigning ? api('GET', '/orders/agents') : null,
  ]);
  const tabs = mode === 'confirm'
    ? [[P.first, 'للتأكيد', P.first.split(',')], ['new', STATUS_LABELS.new, ['new']], ...FAILED.map(([k, l]) => [k, l, [k]]),
      ...P.statuses.filter((k) => !['new', 'no_answer'].includes(k)).map((k) => [k, STATUS_LABELS[k], [k]]), [P.statuses.join(','), 'الكل', P.statuses]]
    : [[P.first, 'الكل', P.statuses], ...P.statuses.map((k) => [k, STATUS_LABELS[k], [k]])];
  const go = (patch) => {
    const p = new URLSearchParams(Object.entries({ ...f, page: '', ...patch }).filter(([, v]) => v !== ''));
    location.hash = `${P.hash}?${p}`;
  };
  // A header with a dropdown filter, like Ecotrack's column headers.
  const hfilter = (label, key, options) => `<th class="hf"><select data-filter="${key}" class="${f[key] ? 'on' : ''}">
      <option value="">${label}</option>
      ${options.map(([v, l]) => `<option value="${v}" ${String(v) === f[key] ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></th>`;
  const from = list.total ? (page - 1) * pageSize() + 1 : 0;
  const pages = Math.max(1, Math.ceil(list.total / pageSize()));

  const main = shell(`
    <h2>${P.title}</h2>
    <div class="tabs">${tabs.map(([key, label, keys]) =>
      `<button class="tab ${key === f.status ? 'active' : ''}" data-status="${key}">${label}
        <span class="n">${keys.reduce((a, k) => a + (stats.by_status[k] || 0), 0)}</span></button>`).join('')}</div>
    <form class="bar" id="filters">
      <input class="grow" name="q" placeholder="بحث: الاسم، الهاتف، رقم الطلبية، التراكينغ" value="${esc(f.q)}">
      <button class="btn">بحث</button>
      ${ORDER_FILTERS.some((k) => !['status', 'page'].includes(k) && f[k]) ? '<button class="btn" type="button" id="clear">مسح الفلاتر</button>' : ''}
      ${mode === 'confirm' && isAdminUser() ? '<button class="btn" type="button" id="pull" title="يجيب دوكا الطلبيات الجديدة من LightFunnels ومن الشيتات">تحديث الطلبيات</button>' : ''}
      ${mode === 'confirm' && can('confirm.add') ? '<button class="btn primary" type="button" id="new-order">+ طلبية يدوية</button>' : ''}
      ${can('tracking.sync') && mode === 'tracking' ? '<button class="btn" type="button" id="sync">تحديث حالات التوصيل</button>' : ''}
    </form>
    <div class="bulk hidden" id="bulk"><b id="bulk-n"></b>
      <select id="bulk-action"><option value="">تبديل الحالة للمحددين…</option>
        ${[['confirm', 'مؤكدة', 'confirm.confirm'], ['no_answer', 'فاشلة (ما ردش +1)', 'confirm.fail'], ['postpone', 'مؤجلة', 'confirm.fail'], ['cancel', 'ملغاة', 'confirm.cancel']]
    .filter(([, , perm]) => can(perm)).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      <button class="btn small" id="bulk-go">تطبيق</button>
      ${assigning ? `<span class="bulk-sep"></span>
      <select id="assign-to"><option value="">عطيهم لـ…</option>
        ${team.agents.map((u) => `<option value="${u.id}">${esc(u.username)}</option>`).join('')}<option value="0">— نحيهم من المؤكدة</option></select>
      <label class="check"><input type="checkbox" id="assign-new"> كطلبيات جديدة (المحاولات ترجع 0)</label>
      <button class="btn small primary" id="assign-go">عطيهم</button>` : ''}</div>
    ${assigning && isAdminUser() ? `<div class="bar muted">
      <label class="check">الفاشلة تتحول وحدها لـ"المؤكدة 2" ومن بعد "المؤكدة 3" تاع المنتج (تختارهم في صفحة المنتجات) بعد كل
        <input id="auto-transfer" type="number" min="0" max="20" value="${team.auto_transfer_after}" style="width:60px"> فاشلات (مثلا 2: بعد الفاشلة 2 والفاشلة 4) — 0 = لا</label>
      ${team.agents.length ? '' : '<span class="neg">مازال ما زدت حتى مؤكدة (صفحة المستخدمين)</span>'}</div>` : ''}
    <div class="table-wrap orders-wrap" id="orders-wrap"><table class="orders">
      <thead><tr>
        <th><input type="checkbox" id="check-all"></th>
        ${hfilter('المصدر', 'source', Object.entries(SOURCE_LABELS))}
        <th>رقم الطلبية</th><th>التاريخ</th><th>الاسم الكامل</th><th>الهاتف</th><th>اتصال</th>
        ${hfilter('الحالة', 'status', P.statuses.flatMap((k) => (k === 'no_answer' ? FAILED : [[k, STATUS_LABELS[k]]])))}
        <th>العنوان</th>
        ${hfilter('البوتيك', 'store_id', stores.map((s) => [s.id, s.name]))}
        ${hfilter('نوع التوصيل', 'stop_desk', [['0', 'المنزل'], ['1', 'مكتب']])}
        ${hfilter('الولاية', 'wilaya', state.meta.wilayas.map((w) => [w.code, `${w.code} - ${w.name_fr}`]))}
        <th>البلدية</th>
        ${hfilter('المنتج', 'product_id', products.map((p) => [p.id, p.name]))}
        <th>المتغير</th><th>سعر المنتج</th><th>الكمية</th><th>سعر التوصيل</th><th>السعر الكلي</th><th>التفاصيل</th>
        ${hfilter('شركة التوصيل', 'company_id', companies.map((c) => [c.id, c.name]))}
        ${assigning ? hfilter('المؤكدة', 'assigned_to', [['none', 'بلا مؤكدة'], ...team.agents.map((u) => [u.id, u.username])]) : ''}
        <th>التأكيد بواسطة</th><th>الإجراءات</th>
      </tr></thead>
      <tbody>${list.rows.map((o) => orderRow(o, products, companies, stores)).join('')
        || '<tr><td colspan="22" class="muted" style="text-align:center;padding:30px">ما كاين حتى طلبية</td></tr>'}</tbody>
    </table></div>
    <div class="pager"><span class="muted">${from}-${from ? from + list.rows.length - 1 : 0} من ${list.total}</span>
      <span>${page > 1 ? `<button class="btn small" data-page="${page - 1}">‹ السابقة</button>` : ''}
        <span class="page-n">${page} / ${pages}</span>
        ${page < pages ? `<button class="btn small" data-page="${page + 1}">التالية ›</button>` : ''}</span>
      <label class="muted">في الصفحة <select id="page-size">${PAGE_SIZES.map((n) => `<option ${n === pageSize() ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>`);
  bindOrderTable(main.querySelector('table.orders'), list.rows, products, companies, stores);

  main.querySelectorAll('[data-status]').forEach((b) => (b.onclick = () => go({ status: b.dataset.status })));
  main.querySelectorAll('[data-filter]').forEach((s) => (s.onchange = () => go({ [s.dataset.filter]: s.value })));
  main.querySelectorAll('[data-page]').forEach((b) => (b.onclick = () => go({ page: b.dataset.page })));
  main.querySelector('#page-size').onchange = (e) => {
    try { localStorage.setItem('erp_page_size', e.target.value); } catch { /* private window: keeps 50 */ }
    const before = location.hash;
    go({ page: '' });
    if (location.hash === before) router();
  };
  main.querySelector('#filters').onsubmit = (e) => {
    e.preventDefault();
    go({ q: e.target.elements.q.value });
  };
  const clear = main.querySelector('#clear');
  if (clear) clear.onclick = () => go(Object.fromEntries(ORDER_FILTERS.filter((k) => k !== 'status').map((k) => [k, ''])));
  const add = main.querySelector('#new-order');
  if (add) add.onclick = () => orderForm(null, products);
  const pull = main.querySelector('#pull');
  if (pull) {
    pull.onclick = guard(async () => {
      pull.disabled = true;
      pull.textContent = 'جاري التحديث...';
      const r = await api('POST', '/orders/pull');
      const errors = [...r.sheet_errors, ...r.lightfunnels_errors];
      toast(`دخلو ${r.lightfunnels} من LightFunnels و${r.sheets} من الشيتات${errors.length ? `. أخطاء: ${errors.slice(0, 2).join(' | ')}` : ''}`, errors.length > 0);
      router();
    });
  }
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
  if (assigning) {
    main.querySelector('#assign-go').onclick = guard(async () => {
      const to = main.querySelector('#assign-to').value;
      const ids = checked();
      if (to === '' || !ids.length) return toast('اختار المؤكدة', true);
      const r = await api('POST', '/orders/assign', { ids, user_id: Number(to) || null, as_new: main.querySelector('#assign-new').checked });
      toast(`تعطاو ${r.assigned} طلبية`);
      router();
    });
    const auto = main.querySelector('#auto-transfer');
    if (auto) auto.onchange = guard(async (e) => {
      await api('PUT', '/orders/agents', { auto_transfer_after: e.target.value });
      toast('تم الحفظ');
    });
  }
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

// Every table gets a second horizontal scrollbar above it, kept in step with the one below.
function syncTopScroll(wrap) {
  wrap.dataset.scroll = '1';
  const top = document.createElement('div');
  top.className = 'top-scroll';
  top.innerHTML = '<div></div>';
  wrap.before(top);
  const fit = () => {
    top.firstElementChild.style.width = `${wrap.scrollWidth}px`;
    top.classList.toggle('hidden', wrap.scrollWidth <= wrap.clientWidth);
    top.scrollLeft = wrap.scrollLeft;
  };
  let busy = false;
  const mirror = (from, to) => () => {
    if (busy) return;
    busy = true;
    to.scrollLeft = from.scrollLeft;
    requestAnimationFrame(() => (busy = false));
  };
  top.addEventListener('scroll', mirror(top, wrap));
  wrap.addEventListener('scroll', mirror(wrap, top));
  fit();
  const ro = new ResizeObserver(fit);
  ro.observe(wrap);
  if (wrap.firstElementChild) ro.observe(wrap.firstElementChild);
}
new MutationObserver(() => app.querySelectorAll('.table-wrap:not([data-scroll])').forEach(syncTopScroll))
  .observe(app, { childList: true, subtree: true });

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
// The permission box each order action needs (same as the server).
const ACTION_PERM = {
  confirm: 'confirm.confirm', no_answer: 'confirm.fail', postpone: 'confirm.fail', reset: 'confirm.fail', set_failed: 'confirm.fail',
  unfail: 'confirm.fail', reopen: 'confirm.cancel', delivered: 'tracking.delivered', returned: 'tracking.returned', return_received: 'tracking.returned',
};
const CONFIRM_STAGE = ['new', 'no_answer', 'postponed', 'cancelled', 'fake'];
const mayAct = (o, action) => can(action === 'cancel' ? (CONFIRM_STAGE.includes(o.status) ? 'confirm.cancel' : 'tracking.cancel') : ACTION_PERM[action]);

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
const SOURCE_ICON = { sheet: 'sheet', lightfunnels: 'web', abandoned: 'cart', landing: 'web', manual: 'hand' };

function statusCell(o) {
  const moves = STATUS_MOVES[o.status];
  if (o.status === 'returned') return `<span class="pill returned">${o.return_received_at ? 'روتور (وصل)' : 'روتور (في الطريق)'}</span>`;
  if (!moves) return `<span class="pill ${o.status}">${STATUS_LABELS[o.status] || o.status}</span>`;
  const opts = [o.status, ...moves.filter((s) => s !== o.status && mayAct(o, moveAction(o.status, s)))];
  if (opts.length === 1 && !(o.status === 'no_answer' && can('confirm.fail'))) return `<span class="pill ${o.status}">${STATUS_LABELS[o.status] || o.status}</span>`;
  const label = (s) => (s === 'no_answer' ? `الفاشلة ${(o.call_attempts || 0) + 1}` : STATUS_LABELS[s]);
  // A failed order can also go back to a lower failed number (pressed by mistake).
  const now = Math.min(5, Math.max(1, o.call_attempts || 0));
  const failed = o.status === 'no_answer' && can('confirm.fail') ? FAILED.map(([k, l], i) => [k, l, i + 1 === now]) : [];
  return `<select class="pill ${o.status}" data-move>
    ${failed.map(([k, l, sel]) => `<option value="${k}" ${sel ? 'selected' : ''}>${l}</option>`).join('')}
    ${opts.filter((s) => !(failed.length && s === 'no_answer')).map((s) =>
    `<option value="${s}" ${s === o.status && !failed.length ? 'selected' : ''}>${label(s)}</option>`).join('')}</select>`;
}

function orderRow(o, products, companies, stores) {
  const open = EDITABLE.includes(o.status);
  // Each field opens only with its permission box; a confirmed order needs "tracking.edit".
  const may = (perm) => open && can(CONFIRM_STAGE.includes(o.status) ? perm : 'tracking.edit');
  const edit = may('confirm.edit');
  // The agent column is shown to those who give orders out, on the confirmation page.
  const showAgent = can('confirm.assign') && location.hash.split('?')[0] === '#/orders';
  const text = (field, value, attrs = '') => (edit
    ? `<input class="cell" data-field="${field}" value="${esc(value ?? '')}" ${attrs}>`
    : `<span>${esc(value ?? '')}</span>`);
  const num = (field, value, w = 64) => (may({ unit_price: 'confirm.price', delivery_fee: 'confirm.delivery_price' }[field])
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
      ${text('phone', o.phone, 'style="width:100px" dir="ltr"')}
      <span class="cust-check ${o.returned_count > o.delivered_count ? 'bad' : o.returned_count ? 'warn' : o.delivered_count ? 'good' : ''}"
        title="هاد الزبون: ${o.delivered_count} مستلمة و ${o.returned_count} روتور">✅ ${o.delivered_count} · ↩️ ${o.returned_count}</span></td>
    <td class="nowrap"><span class="calls ${o.call_attempts ? 'has' : ''}" title="محاولات الاتصال">${o.call_attempts || 0} ✆</span>
      ${['new', 'no_answer', 'postponed'].includes(o.status) && can('confirm.fail') ? '<button class="plus" data-attempt title="ما ردش: الفاشلة اللي بعدها">+1</button>' : ''}
      ${o.status === 'no_answer' && can('confirm.fail') ? '<button class="plus" data-unattempt title="غلطت: الفاشلة اللي قبلها">-1</button>' : ''}</td>
    <td class="nowrap">${statusCell(o)}${o.dispatch_error ? `<div class="err" title="${esc(o.dispatch_error)}">خطأ إرسال</div>` : ''}</td>
    <td>${text('address', o.address, 'style="width:120px"')}</td>
    <td>${can('products.edit') && edit
      ? `<select class="cell drop ${o.store_id ? '' : 'missing'}" data-store title="البوتيك تاع المنتج: يتبدل للمنتج كامل">
          <option value="">— بلا بوتيك</option>
          ${stores.map((s) => `<option value="${s.id}" ${s.id === o.store_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`
      : esc(o.store_name || '—')}</td>
    <td>${edit ? pick('stop_desk', [['0', 'المنزل'], ['1', 'مكتب']], o.stop_desk ? '1' : '0') : o.stop_desk ? 'مكتب' : 'المنزل'}</td>
    <td>${edit ? pick('wilaya_code', state.meta.wilayas.map((w) => [w.code, `${w.code} - ${w.name_fr}`]), o.wilaya_code || '', o.wilaya_code ? '' : 'اختر الولاية', 'w') : esc(wilaya(o.wilaya_code))}</td>
    <td>${text('commune', o.commune, 'style="width:110px"')}</td>
    <td class="prod-cell" title="${esc(o.product_name)}"><div class="clamp">${esc(o.product_name)}</div>${o.items?.length ? `<div class="extra-items" title="${esc(o.items.map((i) => `${i.product_name} × ${i.quantity}`).join('، '))}">+ ${o.items.map((i) => `${esc(i.product_name)} × ${i.quantity}`).join('، ')}</div>` : ''}</td>
    <td class="variant-cell">${text('variant', o.variant, 'style="width:120px" placeholder="—"')}</td>
    <td class="num">${num('unit_price', o.unit_price)}</td>
    <td class="num">${edit ? `<input class="cell num" data-field="quantity" value="${o.quantity}" type="number" min="1" style="width:44px">` : o.quantity}</td>
    <td class="num">${num('delivery_fee', o.delivery_fee, 56)}</td>
    <td class="num"><b>${Math.round(Number(o.total) || 0)}</b></td>
    <td class="details">${edit
      ? `<textarea class="cell" data-field="notes" rows="1" placeholder="—">${esc(o.notes || '')}</textarea>`
      : esc(o.notes || '')}</td>
    <td>${may('confirm.company') ? pick('company_id', companies.map((c) => [c.id, c.name]), o.company_id, '— بلا شركة', o.company_id ? '' : 'missing') : esc(o.company_name || '')}
      ${o.tracking ? `<div class="muted" dir="ltr">${esc(o.tracking)}</div>` : ''}</td>
    ${showAgent ? `<td>${o.assigned_name ? `<b>${esc(o.assigned_name)}</b>` : '<span class="muted">—</span>'}</td>` : ''}
    <td class="muted">${esc(o.confirmed_by || '')}</td>
    <td class="acts nowrap">
      ${can('confirm.delete') && !['dispatched', 'delivered', 'returned'].includes(o.status) ? `<button data-delete title="حذف">${icon('trash', 'red')}</button>` : ''}
      <button data-open title="السجل">${icon('clock')}</button>
      ${o.status === 'confirmed' && can('tracking.dispatch') ? `<button data-dispatch title="إرسال لشركة التوصيل" class="dark">${icon('send')}</button>` : ''}
      ${edit ? `<button data-edit title="تعديل كامل">${icon('edit', 'green')}</button>` : ''}
      ${(o.status === 'confirmed' && can('tracking.back')) || (o.status === 'dispatched' && can('tracking.back_dispatched'))
        ? `<button data-back title="رجّعها لتأكيد الطلبيات${o.status === 'dispatched' ? ' (الطرد يتحذف عند شركة التوصيل)' : ''}">${icon('truck', 'red')}</button>` : ''}
      ${o.tracking ? `<button data-open title="التراكينغ: ${esc(o.tracking)}">${icon('truck', 'green')}</button>` : ''}
      ${o.status === 'returned' && !o.return_received_at && can('tracking.returned') ? '<button class="btn small" data-received title="الطرد الراجع وصل ليدك: السلعة ترجع للستوك">وصل الروتور</button>' : ''}
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
      if (el.value.startsWith('failed_')) {
        return save(tr, (id) => api('POST', `/orders/${id}/action`, { action: 'set_failed', attempts: Number(el.value.slice(7)) }));
      }
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
    if (e.target.closest('[data-unattempt]')) return save(tr, () => api('POST', `/orders/${id}/action`, { action: 'unfail' }));
    if (e.target.closest('[data-edit]')) return orderForm(byId.get(id), products);
    if (e.target.closest('[data-dispatch]')) return save(tr, () => api('POST', `/orders/${id}/dispatch`, {}));
    if (e.target.closest('[data-received]')) return save(tr, () => api('POST', `/orders/${id}/action`, { action: 'return_received' }));
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
    <h3>${esc(o.reference)} ${o.status === 'no_answer' ? `<span class="badge no_answer">${failedLabel(o)}</span>` : badge(o.status)}</h3>
    ${o.dispatch_error ? `<div class="alert">خطأ في الإرسال لشركة التوصيل: ${esc(o.dispatch_error)}</div>` : ''}
    ${o.duplicate_of ? `<div class="alert">طلبية مكررة محتملة (نفس الرقم ونفس المنتج، #${o.duplicate_of})</div>` : ''}
    <div class="grid2">
      <div><div class="muted">الزبون</div>${esc(o.customer_name)}</div>
      <div><div class="muted">الهاتف</div><a href="tel:${esc(o.phone)}" dir="ltr">${esc(o.phone)}</a> <a href="${whatsapp(o.phone)}" target="_blank" rel="noopener">💬 WhatsApp</a>${o.phone2 ? ` / <a href="tel:${esc(o.phone2)}" dir="ltr">${esc(o.phone2)}</a>` : ''}</div>
      <div><div class="muted">الولاية / البلدية</div>${wilaya(o.wilaya_code)} / ${esc(o.commune || '—')}</div>
      <div><div class="muted">العنوان</div>${esc(o.address || '—')} ${o.stop_desk ? '<span class="badge">مكتب</span>' : ''}</div>
      <div><div class="muted">${o.items?.length ? 'المنتجات' : 'المنتج'}</div>${esc(o.product_name)} × ${o.quantity}${o.items?.map((i) => `<br>${esc(i.product_name)} × ${i.quantity} <span class="muted">(${money(i.unit_price)})</span>`).join('') || ''}${o.store_name ? ` <span class="muted">(${esc(o.store_name)})</span>` : ''}</div>
      <div><div class="muted">المجموع</div>${money(o.unit_price * o.quantity)} + توصيل ${money(o.delivery_fee)} = <b>${money(o.total)}</b></div>
      <div><div class="muted">شركة التوصيل</div>${esc(o.company_name || 'غير محددة')} ${esc(o.tracking || '')}</div>
      <div><div class="muted">المصدر</div>${SOURCE_LABELS[o.source] || o.source} ${o.utm_campaign ? `· ${esc(o.utm_campaign)}` : ''}</div>
    </div>
    ${o.variant ? `<p><span class="muted">المتغير:</span> ${esc(o.variant)}</p>` : ''}
    ${o.notes ? `<p><span class="muted">ملاحظة:</span> ${esc(o.notes)}</p>` : ''}
    <hr>
    <label>ملاحظة على الإجراء<input id="note" placeholder="اختياري"></label>
    <div class="actions" style="margin-top:10px">
      ${open ? `
        <button class="btn primary" data-action="confirm">✔ تأكيد وإرسال</button>
        <button class="btn" data-action="no_answer">ما ردش (الفاشلة ${(o.call_attempts || 0) + 1})</button>
        ${o.status === 'no_answer' ? '<button class="btn" data-action="unfail" title="غلطت">-1 (الفاشلة اللي قبلها)</button>' : ''}
        <button class="btn" data-action="postpone">تأجيل</button>
        <button class="btn danger" data-action="cancel">إلغاء</button>` : ''}
      ${o.status === 'confirmed' ? `
        <button class="btn primary" data-dispatch>إعادة الإرسال لشركة التوصيل</button>
        <button class="btn" data-manual>إدخال تراكينغ يدوياً</button>
        <button class="btn danger" data-action="cancel">إلغاء</button>` : ''}
      ${o.status === 'dispatched' ? `
        <button class="btn primary" data-action="delivered">مستلمة</button>
        <button class="btn danger" data-action="returned">روتور</button>` : ''}
      ${o.status === 'returned' && !o.return_received_at ? '<button class="btn primary" data-action="return_received">وصل الروتور (يرجع للستوك)</button>' : ''}
      ${['no_answer', 'postponed'].includes(o.status) ? '<button class="btn" data-action="reset">رجعها جديدة</button>' : ''}
      ${o.status === 'cancelled' ? '<button class="btn" data-action="reopen">إعادة فتح</button>' : ''}
      ${['new', 'no_answer', 'postponed', 'confirmed'].includes(o.status) ? '<button class="btn" data-edit>تعديل</button>' : ''}
      <button class="btn" data-close>إغلاق</button>
    </div>
    <h4>السجل</h4>
    <ul class="timeline">${o.events.map((e) =>
      `<li><span class="muted">${esc(fmtDate(e.created_at))}</span> · ${esc(EVENT_LABELS[e.type] || e.type)} ${e.message ? `— ${esc(e.message)}` : ''} ${e.username ? `<span class="muted">(${esc(e.username)})</span>` : ''}</li>`).join('')}</ul>`);

  // Only the buttons this account has the boxes for.
  box.querySelectorAll('[data-action]').forEach((b) => mayAct(o, b.dataset.action) || b.remove());
  if (!can('tracking.dispatch')) box.querySelectorAll('[data-dispatch], [data-manual]').forEach((b) => b.remove());
  if (!can(CONFIRM_STAGE.includes(o.status) ? 'confirm.edit' : 'tracking.edit')) box.querySelector('[data-edit]')?.remove();
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
  // A field this account has no box for stays shown but can't be changed.
  const lock = (perm) => (order && !can(CONFIRM_STAGE.includes(o.status) ? perm : 'tracking.edit') ? 'disabled' : '');
  const productOptions = (selected) => products.filter((p) => (p.active && !p.archived) || p.id === selected)
    .map((p) => `<option value="${p.id}" data-price="${p.price}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)} — ${money(p.price)}</option>`).join('');
  // One more product of the same parcel: product, quantity, unit price.
  const itemRow = (i = {}) => `<div class="grid3 item-row">
    <label>المنتج<select data-item="product_id">${productOptions(i.product_id)}</select></label>
    <label>الكمية<input data-item="quantity" type="number" min="1" value="${i.quantity || 1}"></label>
    <div class="actions" style="align-self:end"><label style="flex:1">سعر الوحدة<input data-item="unit_price" type="number" value="${i.unit_price ?? ''}" placeholder="سعر المنتج"></label>
      <button class="btn small danger" type="button" data-remove-item>✕</button></div></div>`;
  const box = modal.open(`
    <h3>${order ? `تعديل ${esc(order.reference)}` : 'طلبية جديدة'}</h3>
    <form class="stack" id="order-form">
      ${order?.stock_reserved ? '' : order && !isAdminUser()
    // Only the admin changes the main product of an order; the others can add products below.
    ? `<div><div class="muted">المنتج (المدير برك يبدلو)</div><div class="prod-cell"><b>${esc(o.product_name)}</b></div></div>`
    : `<label>المنتج<select name="product_id" required>${productOptions(o.product_id)}</select></label>`}
      <div class="grid2">
        <label>الاسم<input name="customer_name" value="${esc(o.customer_name)}" required></label>
        <label>الهاتف<input name="phone" value="${esc(o.phone)}" required dir="ltr"></label>
        <label>هاتف 2<input name="phone2" value="${esc(o.phone2)}" dir="ltr"></label>
        <label>الولاية<select name="wilaya_code">${wilayaOptions(o.wilaya_code)}</select></label>
        <label>البلدية<input name="commune" value="${esc(o.commune)}"></label>
        <label>العنوان<input name="address" value="${esc(o.address)}"></label>
        <label>الكمية<input name="quantity" type="number" min="1" value="${o.quantity}"></label>
        <label>سعر الوحدة<input name="unit_price" type="number" value="${order ? o.unit_price : ''}" placeholder="سعر المنتج" ${lock('confirm.price')}></label>
        ${order ? `<label>سعر التوصيل<input name="delivery_fee" type="number" value="${o.delivery_fee}" ${lock('confirm.delivery_price')}></label>
        <label>شركة التوصيل<select name="company_id" ${lock('confirm.company')}><option value="">حسب الولاية</option>
          ${companies.map((c) => `<option value="${c.id}" ${c.id === o.company_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>` : ''}
      </div>
      ${order?.stock_reserved ? (o.items?.length ? `<div class="muted">منتجات أخرى: ${o.items.map((i) => `${esc(i.product_name)} × ${i.quantity}`).join('، ')}</div>` : '') : `
      <div class="stack" id="extra-items">
        <div class="muted">منتجات أخرى في نفس الطرد</div>
        ${(o.items || []).map(itemRow).join('')}
      </div>
      <div><button class="btn small" type="button" id="add-item">+ منتج آخر</button></div>`}
      <div class="muted" id="order-total"></div>
      <label class="check"><input type="checkbox" name="stop_desk" ${o.stop_desk ? 'checked' : ''}> استلام من المكتب (Stop desk)</label>
      <label>المتغير (المقاس، اللون)<input name="variant" value="${esc(o.variant || '')}"></label>
      <label>ملاحظة<textarea name="notes">${esc(o.notes)}</textarea></label>
      <div class="actions"><button class="btn primary">حفظ</button><button class="btn" type="button" data-close>إلغاء</button></div>
    </form>`);
  const form = box.querySelector('#order-form');
  const extra = form.querySelector('#extra-items');
  const priceOf = (select) => Number(select.selectedOptions[0]?.dataset.price || 0);
  const readItems = () => [...form.querySelectorAll('.item-row')].map((row) => {
    const get = (k) => row.querySelector(`[data-item="${k}"]`);
    return { product_id: Number(get('product_id').value), quantity: Number(get('quantity').value) || 1, unit_price: get('unit_price').value };
  });
  // Products total shown while typing; the delivery fee is added by the server.
  const showTotal = () => {
    const main = form.elements.product_id;
    const mainPrice = form.elements.unit_price.value !== '' ? Number(form.elements.unit_price.value) : main ? priceOf(main) : o.unit_price;
    const lines = (Number(form.elements.quantity.value) || 1) * mainPrice + [...form.querySelectorAll('.item-row')].reduce((a, row) => {
      const price = row.querySelector('[data-item=unit_price]').value;
      return a + (Number(row.querySelector('[data-item=quantity]').value) || 1) * (price !== '' ? Number(price) : priceOf(row.querySelector('[data-item=product_id]')));
    }, 0);
    form.querySelector('#order-total').textContent = `مجموع المنتجات: ${money(lines)} (+ سعر التوصيل)`;
  };
  form.addEventListener('input', showTotal);
  form.addEventListener('change', showTotal);
  if (extra) {
    form.querySelector('#add-item').onclick = () => { extra.insertAdjacentHTML('beforeend', itemRow()); showTotal(); };
    extra.addEventListener('click', (e) => { if (e.target.closest('[data-remove-item]')) { e.target.closest('.item-row').remove(); showTotal(); } });
  }
  showTotal();
  form.onsubmit = guard(async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    f.stop_desk = Boolean(f.stop_desk);
    if (f.unit_price === '') delete f.unit_price;
    if (extra) f.items = readItems();
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
// Reads the old parcels of every store account, page by page, for the customer check.
async function historyDialog() {
  const box = modal.open(`<h3>الداتا القديمة للتحقق</h3>
    <p class="muted">نقراو الطرود تاع آخر عام عند كل حساب (Ecotrack). نحفظو غير الرقم والنتيجة (مستلمة ولا روتور). ما نبدلو والو عندهم.</p>
    <ul class="timeline" id="history-log"></ul><div class="actions"><button class="btn" data-close>إغلاق</button></div>`);
  const log = (html) => box.querySelector('#history-log').insertAdjacentHTML('beforeend', `<li>${html}</li>`);
  const accounts = await api('GET', '/history/accounts');
  if (!accounts.length) log('<span class="neg">ما كاين حتى حساب Ecotrack بالتوكن</span>');
  for (const a of accounts) {
    let page = 1;
    let last = 1;
    let kept = 0;
    try {
      do {
        const r = await api('POST', '/history/import', { store_id: a.store_id, company_id: a.company_id, page });
        kept += r.kept;
        last = r.last_page;
        page += 1;
      } while (page <= last && box.isConnected);
      log(`${esc(a.store_name)} · ${esc(a.company_name)}: ${kept} طرد (مستلمة/روتور)`);
    } catch (err) {
      log(`${esc(a.store_name)} · ${esc(a.company_name)}: <span class="neg">${esc(err.message)}</span>`);
    }
  }
  log('<b>كمل</b>');
}

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
      // Not read = not in the comparison, so its products are left alone.
      delete texts[s.id];
      log(`<span class="neg">${esc(err.message)}</span>`);
    }
  }
  const r = await api('POST', '/branches/apply', { texts });
  log(`<b>${r.linked.length} منتج تربط</b>${r.kept ? `، ${r.kept} كانو مربوطين صح` : ''}`);
  r.linked.forEach((l) => log(`${esc(l.product)} ← ${esc(l.to)}${l.from ? ` <span class="muted">(كان ${esc(l.from)})</span>` : ''}${l.orders ? ` · ${l.orders} طلبية` : ''}`));
  if (r.unmatched.length) log(`<span class="neg">ما لقيناش الفرع تاع:</span> ${r.unmatched.map(esc).join('، ')}`);
  box.querySelector('[data-close]').onclick = () => { modal.close(); router(); };
}

// ---------- accounting: profit of each product ----------
const MODE_LABELS = { auto: 'أوتوماتيكي', default: 'ثابت', manual: 'يدوي', empty: 'فارغ' };
const STATE_LABELS = { profit: 'ربح', selling: 'قيد البيع', loss: 'خسارة', none: '—' };

async function accountingPage() {
  const [a, allStores] = await Promise.all([api('GET', '/accounting'), api('GET', '/stores')]);
  // An accountant limited to some stores sees only those.
  const limited = state.user.accounting_store_ids || [];
  const stores = limited.length ? allStores.filter((st) => limited.includes(st.id)) : allStores;
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const storeId = q.get('store_id') || '';
  const picked = new Set((q.get('products') || '').split(',').filter(Boolean));
  const inStore = a.products.filter((p) => !storeId || String(p.store_id) === storeId);
  const products = picked.size ? inStore.filter((p) => picked.has(String(p.id))) : inStore;
  const goTo = (store, ids) => {
    const params = new URLSearchParams();
    if (store) params.set('store_id', store);
    if (ids.length) params.set('products', ids.join(','));
    location.hash = `#/accounting${params.size ? `?${params}` : ''}`;
  };
  const unit = a.unit_fields;
  const defaultFields = [...Object.entries(unit).map(([k, f]) => [k, `${f.label} (لكل ${f.per})`]), ['creative', 'الكرياتيف (للمنتج)'], ['fx_rate', 'سعر صرف الدولار']];
  // Totals of the products shown: profit, and the goods left with their purchase value.
  const sum = (list) => list.reduce((t, p) => ({
    revenue: t.revenue + p.revenue, expenses: t.expenses + p.expenses, profit: t.profit + p.profit,
    in_hand: t.in_hand + p.pieces.in_hand, left_value: t.left_value + p.left_value,
    returning: t.returning + p.pieces.returning, returning_value: t.returning_value + p.returning_value,
  }), { revenue: 0, expenses: 0, profit: 0, in_hand: 0, left_value: 0, returning: 0, returning_value: 0 });
  const t = sum(products);
  const byStore = stores.map((st) => ({ store: st, ...sum(a.products.filter((p) => p.store_id === st.id)) }))
    .filter((x) => x.revenue || x.expenses || x.in_hand || x.returning);
  const big = (label, value, cls = '', sub = '') => `<div class="stat-card ${cls}"><div class="l">${esc(label)}</div><div class="v">${value}</div>${sub ? `<div class="muted">${sub}</div>` : ''}</div>`;
  const main = shell(`
    <h2>الفايدة لكل منتج</h2>
    <div class="bar"><label>البوتيك<select id="acc-store"><option value="">كل البوتيكات</option>
      ${stores.map((st) => `<option value="${st.id}" ${String(st.id) === storeId ? 'selected' : ''}>${esc(st.name)}</option>`).join('')}</select></label>
      <div class="multi"><span class="multi-label">المنتجات</span>
        <details id="acc-products"><summary>${picked.size ? `${picked.size} منتج مختار` : 'كل المنتجات'}</summary>
          <div class="multi-box">
            <input type="search" id="acc-search" placeholder="ابحث على منتج…">
            <div class="multi-list">${inStore.map((p) => `<label class="check" data-name="${esc(p.name.toLowerCase())}">
              <input type="checkbox" value="${p.id}" ${picked.has(String(p.id)) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('')}</div>
            <div class="actions"><button class="btn small primary" type="button" id="acc-apply">عرض</button>
              <button class="btn small" type="button" id="acc-clear">كل المنتجات</button></div>
          </div></details></div></div>
    <div class="card">
      <h3 class="card-title">الملخص: ${esc(storeId ? stores.find((st) => String(st.id) === storeId)?.name || '' : 'كل البوتيكات')} (${products.length} منتج${picked.size ? ' مختار' : ''})</h3>
      <div class="stat-cards">
        ${big('المبيعات', money(t.revenue), 'blue')}
        ${big('المصاريف', money(t.expenses), 'orange')}
        ${big('الفايدة', money(t.profit), t.profit < 0 ? 'red' : 'green')}
        ${big('الكمية الباقية عندي (ملموسة)', t.in_hand, 'green', `قيمتها بسعر الشراء: <b>${money(t.left_value)}</b>`)}
        ${big('روتور جاي (غير ملموسة)', t.returning, 'purple', `قيمتو: <b>${money(t.returning_value)}</b>`)}
        ${big('الكمية الباقية كاملة', t.in_hand + t.returning, 'grey', `قيمتها: <b>${money(t.left_value + t.returning_value)}</b>`)}
      </div>
    </div>
    ${!storeId && !picked.size && byStore.length ? `<div class="card"><h3 class="card-title">حسب البوتيك</h3><div class="table-wrap"><table>
      <tr><th>البوتيك</th><th>المبيعات</th><th>المصاريف</th><th>الفايدة</th><th>الباقي عندي</th><th>قيمتو</th><th>روتور جاي</th><th>قيمتو</th></tr>
      ${byStore.map((x) => `<tr><td><a href="#/accounting?store_id=${x.store.id}">${esc(x.store.name)}</a></td>
        <td class="num">${money(x.revenue)}</td><td class="num">${money(x.expenses)}</td>
        <td class="num ${x.profit < 0 ? 'neg' : 'pos'}">${money(x.profit)}</td>
        <td class="num">${x.in_hand}</td><td class="num">${money(x.left_value)}</td>
        <td class="num">${x.returning}</td><td class="num">${money(x.returning_value)}</td></tr>`).join('')}
    </table></div></div>` : ''}
    <div class="table-wrap orders-wrap" id="products-wrap"><table>
      <tr><th>المنتج</th><th>البوتيك</th><th>المبيعات</th><th>المصاريف</th><th>الفايدة</th><th>الوضعية</th><th>مشرية</th><th>عندي</th><th>قيمة الباقي</th><th>عند التوصيل</th><th>تليفرات</th><th>روتور جاي</th><th>ناقص</th><th></th></tr>
      ${products.map((p) => `<tr>
        <td>${esc(p.name)}</td><td>${esc(p.store_name || '—')}</td>
        <td class="num">${money(p.revenue)}</td><td class="num">${money(p.expenses)}</td>
        <td class="num ${p.profit < 0 ? 'neg' : 'pos'}">${money(p.profit)}</td>
        <td>${p.state === 'none' ? '<span class="muted">—</span>' : `<span class="badge ${p.state === 'profit' ? 'delivered' : p.state === 'loss' ? 'cancelled' : 'warn'}">${STATE_LABELS[p.state]}</span>`}</td>
        <td class="num">${p.pieces.bought ?? '<span class="muted">—</span>'}</td>
        <td class="num"><b>${p.pieces.in_hand}</b>${stockGap(p)}</td>
        <td class="num">${money(p.left_value)}</td>
        <td class="num">${p.pieces.at_company + p.pieces.out_for_delivery}</td>
        <td class="num">${p.pieces.delivered}</td>
        <td class="num">${p.pieces.returning || '<span class="muted">0</span>'}</td>
        <td>${p.missing.length ? `<span class="badge warn" title="${esc(p.missing.join('، '))}">${p.missing.length}</span>` : '<span class="muted">—</span>'}</td>
        <td><button class="btn small" data-card="${p.id}">البطاقة</button></td></tr>`).join('') || '<tr><td colspan="14" class="muted">ما كاين حتى منتج في هاد البوتيك</td></tr>'}
    </table></div>
    <p class="muted">الفايدة = المبيعات − كل المصاريف. الشراء يتحسب للدفعة كاملة، والستوك الباقي معلومة برك. التغليف والإتيكات يتحسبو لكل طلبية تبعثت، حتى اللي ولات روتور. <b>عندي</b> = السلعة اللي في يدك (ملموسة)، <b>روتور جاي</b> = راجعة وماوصلتش مازال. كل سطر يكون <b>أوتوماتيكي</b> (من الطلبيات) ولا <b>ثابت</b> (سعر عام تحطو هنا) ولا <b>يدوي</b> (تكتبو للمنتج).</p>
    <div class="card">
      <h3 style="margin-top:0">القيم الثابتة (لكل المنتجات)</h3>
      <form class="grid3" id="defaults">
        ${defaultFields.map(([k, l]) => `<label>${esc(l)}<input name="${k}" type="number" step="any" min="0" value="${a.defaults[k] ?? ''}" placeholder="فارغ = ما حطيتوش"></label>`).join('')}
        <div class="actions" style="align-self:end">${limited.length ? '<span class="muted">يبدلها غير المدير</span>' : '<button class="btn primary">حفظ القيم الثابتة</button>'}</div>
      </form>
    </div>`);
  main.querySelector('#acc-store').onchange = (e) => goTo(e.target.value, []);
  const box = main.querySelector('#acc-products');
  main.querySelector('#acc-search').oninput = (e) => {
    const term = e.target.value.trim().toLowerCase();
    box.querySelectorAll('.multi-list label').forEach((l) => l.classList.toggle('hidden', !!term && !l.dataset.name.includes(term)));
  };
  main.querySelector('#acc-apply').onclick = () => goTo(storeId, [...box.querySelectorAll('.multi-list input:checked')].map((i) => i.value));
  main.querySelector('#acc-clear').onclick = () => goTo(storeId, []);
  main.querySelector('#defaults').onsubmit = guard(async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(defaultFields.map(([k]) => [k, e.target.elements[k].value]));
    await api('PUT', '/accounting/defaults', body);
    toast('تم الحفظ');
    router();
  });
  main.querySelectorAll('[data-card]').forEach((b) => (b.onclick = () => accountingCard(a, a.products.find((p) => p.id === Number(b.dataset.card)))));
}

// The purchases say more (or fewer) pieces should be in hand than the ERP counts.
const stockGap = (p) => (p.pieces.expected_in_hand != null && p.pieces.expected_in_hand !== p.pieces.in_hand
  ? ` <span class="badge warn" title="حسب الشريات لازم يكون عندك ${p.pieces.expected_in_hand}">${p.pieces.expected_in_hand - p.pieces.in_hand > 0 ? '+' : ''}${p.pieces.expected_in_hand - p.pieces.in_hand}</span>` : '');

function accountingCard(a, p) {
  const k = p.pieces;
  const m = p.manual;
  const field = (k, label, hint = '') => `<label>${esc(label)}<input name="${k}" type="number" step="any" min="0" value="${m[k] ?? ''}" placeholder="${esc(hint)}"></label>`;
  const box = modal.open(`
    <h3>${esc(p.name)} ${p.state === 'none' ? '' : `<span class="badge ${p.state === 'profit' ? 'delivered' : p.state === 'loss' ? 'cancelled' : 'warn'}">${STATE_LABELS[p.state]}</span>`}</h3>
    <div class="table-wrap"><table>
      <tr><td><b>المبيعات</b> <span class="muted">(${p.delivered_qty} قطعة متسلمة)</span></td><td class="num"><b>${money(p.revenue)}</b></td><td></td></tr>
      ${p.lines.map((l) => `<tr><td>${esc(l.label)} ${l.note || l.qty != null ? `<span class="muted">${esc(l.note || `${l.qty} ${l.per || ''} × ${l.unit}`)}</span>` : ''}</td>
        <td class="num">${money(l.amount)}</td>
        <td><span class="badge ${l.mode === 'empty' ? 'warn' : ''}">${MODE_LABELS[l.mode]}</span>
          ${l.expense_id ? `<button class="btn small danger" data-del-expense="${l.expense_id}">✕</button>` : ''}</td></tr>`).join('')}
      <tr><td><b>مجموع المصاريف</b></td><td class="num"><b>${money(p.expenses)}</b></td><td></td></tr>
      <tr><td><b>الفايدة</b></td><td class="num ${p.profit < 0 ? 'neg' : 'pos'}"><b>${money(p.profit)}</b></td><td></td></tr>
    </table></div>
    <p class="muted">${p.missing.length ? `ناقص: ${esc(p.missing.join('، '))}. ` : ''}الستوك الباقي معلومة برك، ما يتزادش في الفايدة.</p>
    <h4 style="margin:6px 0">وين راهي السلعة</h4>
    <div class="kpis">
      <div class="kpi"><div class="l">مشرية</div><div class="v">${k.bought ?? '—'}</div></div>
      <div class="kpi"><div class="l">عندي (ملموسة)</div><div class="v">${k.in_hand}</div>${k.reserved ? `<div class="muted">منها ${k.reserved} محجوزة لطلبيات مؤكدة</div>` : ''}</div>
      <div class="kpi"><div class="l">عند شركة التوصيل</div><div class="v">${k.at_company}</div></div>
      <div class="kpi"><div class="l">en livraison</div><div class="v">${k.out_for_delivery}</div></div>
      <div class="kpi"><div class="l">تليفرات</div><div class="v">${k.delivered}</div></div>
      <div class="kpi"><div class="l">روتور جاي (غير ملموسة)</div><div class="v">${k.returning}</div></div>
    </div>
    ${k.expected_in_hand != null && k.expected_in_hand !== k.in_hand ? `<p class="badge warn">حسب الشريات لازم يكون عندك ${k.expected_in_hand} قطعة، والـ ERP يحسب ${k.in_hand}. شوف الستوك.</p>` : ''}
    <h4 style="margin:6px 0">الشريات</h4>
    ${p.purchases.length ? `<div class="table-wrap"><table>
      <tr><th>التاريخ</th><th>الكمية</th><th>سعر القطعة</th><th>المجموع</th><th>ملاحظة</th><th></th></tr>
      ${p.purchases.map((x) => `<tr><td>${esc(x.bought_on)}</td><td class="num">${x.quantity}</td><td class="num">${money(x.unit_price)}</td>
        <td class="num">${money(x.quantity * x.unit_price)}</td><td>${esc(x.note || '')}${x.added_to_stock ? '' : ' <span class="muted">(كانت في الستوك)</span>'}</td>
        <td><button class="btn small danger" data-del-purchase="${x.id}">✕</button></td></tr>`).join('')}
    </table></div>` : '<p class="muted">مازال ما سجلت حتى شرية. كي تسجلها، الشراء يتحسب منها.</p>'}
    <form class="grid3" id="purchase">
      <label>الكمية المشرية<input name="quantity" type="number" min="1" required></label>
      <label>سعر القطعة (دج)<input name="unit_price" type="number" step="any" min="0" required value="${p.purchases.at(-1)?.unit_price ?? ''}"></label>
      <label>التاريخ<input name="bought_on" type="date"></label>
      <label>ملاحظة<input name="note"></label>
      <label class="check"><input type="checkbox" name="add_to_stock" checked> زيدها للستوك (نحيها إذا السلعة راهي محسوبة في الستوك من قبل)</label>
      <div class="actions" style="align-self:end"><button class="btn primary">+ سجل الشرية</button></div>
    </form>
    <form class="stack" id="costs">
      <h4 style="margin:6px 0">قيم خاصة بهاد المنتج (فارغ = القيمة الثابتة ولا الأوتوماتيكية)</h4>
      <div class="grid3">
        ${Object.entries(a.unit_fields).map(([k, f]) => field(k, `${f.label} (لكل ${f.per})`, a.defaults[k] ?? '')).join('')}
        ${Object.entries(a.lump_fields).map(([k, f]) => field(k, f.label, k === 'creative' ? (a.defaults.creative ?? '') : '')).join('')}
        ${field('batch_qty', 'كمية الدفعة', `أوتوماتيكي: ${p.batch_auto}`)}
        ${field('ads_usd', 'الأدس بالدولار', 'فارغ = من مصاريف الإشهار')}
        ${field('fx_rate', 'سعر الصرف', a.defaults.fx_rate ?? '')}
      </div>
      <label class="check"><input type="checkbox" name="selling" ${p.selling ? 'checked' : ''}> المنتج مازال يتباع</label>
      <label>ملاحظة<input name="notes" value="${esc(p.notes || '')}"></label>
      <div class="actions"><button class="btn primary">حفظ</button><button class="btn" type="button" data-close>إغلاق</button></div>
    </form>
    <form class="grid3" id="expense" style="margin-top:12px">
      <label>مصروف آخر: الاسم<input name="name" required></label>
      <label>المبلغ<input name="amount" type="number" step="any" min="0" required></label>
      <div class="actions" style="align-self:end"><button class="btn">+ زيد</button></div>
    </form>`);
  const reopen = async () => {
    const fresh = await api('GET', '/accounting');
    modal.close();
    accountingCard(fresh, fresh.products.find((x) => x.id === p.id));
  };
  const saveCosts = async () => {
    const els = box.querySelector('#costs').elements;
    const body = Object.fromEntries(Object.keys(m).map((k) => [k, els[k].value]));
    body.selling = els.selling.checked;
    body.notes = els.notes.value;
    await api('PUT', `/accounting/products/${p.id}`, body);
  };
  box.querySelector('#costs').onsubmit = guard(async (e) => {
    e.preventDefault();
    await saveCosts();
    toast('تم الحفظ');
    await reopen();
  });
  box.querySelector('#expense').onsubmit = guard(async (e) => {
    e.preventDefault();
    await saveCosts();
    await api('POST', `/accounting/products/${p.id}/expenses`, { name: e.target.elements.name.value, amount: e.target.elements.amount.value });
    await reopen();
  });
  box.querySelector('#purchase').onsubmit = guard(async (e) => {
    e.preventDefault();
    const el = e.target.elements;
    await saveCosts();
    await api('POST', `/accounting/products/${p.id}/purchases`, {
      quantity: el.quantity.value, unit_price: el.unit_price.value, bought_on: el.bought_on.value, note: el.note.value, add_to_stock: el.add_to_stock.checked,
    });
    toast('تسجلت الشرية');
    await reopen();
  });
  box.querySelectorAll('[data-del-purchase]').forEach((b) => (b.onclick = guard(async () => {
    if (!confirm('نحذف هاد الشرية؟ إذا كانت تزادت للستوك، الكمية تنقص منو.')) return;
    await saveCosts();
    await api('DELETE', `/accounting/purchases/${b.dataset.delPurchase}`);
    await reopen();
  })));
  box.querySelectorAll('[data-del-expense]').forEach((b) => (b.onclick = guard(async () => {
    await saveCosts();
    await api('DELETE', `/accounting/expenses/${b.dataset.delExpense}`);
    await reopen();
  })));
}

// ---------- products ----------
async function productsPage() {
  const showArchived = new URLSearchParams(location.hash.split('?')[1] || '').get('archived') === '1';
  const [all, stores, companies, team] = await Promise.all([api('GET', '/products'), api('GET', '/stores'), api('GET', '/delivery/companies'),
    isAdminUser() ? api('GET', '/orders/agents') : null]);
  const isAdmin = can('products.edit');
  const products = all.filter((p) => Boolean(p.archived) === showArchived);
  const archivedCount = all.filter((p) => p.archived).length;
  const agents = team ? team.agents.map((u) => ({ id: u.id, name: u.username })) : [];
  const select = (field, list, selected, empty) => `<select class="cell" data-product-field="${field}" data-orig="${selected ?? ''}"><option value="">${empty}</option>
    ${list.map((x) => `<option value="${x.id}" ${x.id === selected ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`;
  const main = shell(`
    <h2>${showArchived ? 'المنتجات المخفية' : 'المنتجات'}</h2>
    ${isAdmin ? `<div class="bar"><button class="btn primary" id="add">+ منتج جديد</button>
      <a class="btn" href="${showArchived ? '#/products' : '#/products?archived=1'}">${showArchived ? 'رجوع للمنتجات' : `المخفيين (${archivedCount})`}</a>
      <button class="btn primary hidden" id="save-all"></button>
      <button class="btn" id="link-stores" title="يقرا الطرود اللي بعثها كل فرع عند شركة التوصيل تاعو، ويعرف منها كل منتج لأنهي فرع">ربط المنتجات بالفروع تلقائياً</button>
      <button class="btn" id="merge-variants" title="المنتجات اللي تسجلو بالمقاس واللون في الاسم يولو منتج واحد، والمقاس/اللون يروح لعمود المتغير في الطلبيات">جمع المنتجات المكررة بالمتغير</button></div>` : ''}
    <div class="table-wrap"><table>
      <tr><th>المنتج</th><th>البوتيك</th><th>شركة التوصيل</th>${team ? '<th title="الفاشلة تاع هاد المنتج تروح للمؤكدة 2، ومن بعد للمؤكدة 3">المؤكدة 2</th><th>المؤكدة 3</th>' : ''}<th>السعر</th><th>سعر الشراء</th><th>المخزون</th><th>صفحة الهبوط</th><th>طلبيات</th><th></th></tr>
      ${products.map((p) => `<tr data-product="${p.id}">
        <td>${esc(p.name)} ${p.sku ? `<span class="muted">${esc(p.sku)}</span>` : ''} ${p.active ? '' : '<span class="badge">موقف</span>'}</td>
        <td>${isAdmin ? select('store_id', stores, p.store_id, '— بلا بوتيك —') : esc(p.store_name || '—')}</td>
        <td>${isAdmin ? select('company_id', companies, p.company_id, `نفس البوتيك${p.company_from_store && p.company_name ? ` (${esc(p.company_name)})` : ''}`)
          : esc(p.company_name || '—')}</td>
        ${team ? `<td>${select('backup_agent_id', agents, p.backup_agent_id, '— بلا —')}</td>
          <td>${select('third_agent_id', agents, p.third_agent_id, '— بلا —')}</td>` : ''}
        <td class="num">${money(p.price)}</td><td class="num">${money(p.cost)}</td>
        <td class="num ${p.stock <= 5 ? 'neg' : ''}">${p.stock}</td>
        <td>${p.landing_url ? `<a href="${esc(p.landing_url)}" target="_blank" rel="noopener">فتح</a>` : '<span class="muted">—</span>'}</td>
        <td class="num">${p.orders_count} <span class="muted">(${p.pending_count} للتأكيد)</span></td>
        <td class="actions">
          <span class="save-box hidden"><button class="btn small primary" data-save>حفظ</button>
            <button class="btn small" data-cancel>إلغاء</button></span>
          <button class="btn small" data-embed="${p.id}">ربط صفحة الهبوط</button>
          ${isAdmin ? `<button class="btn small" data-edit="${p.id}">تعديل</button>` : ''}
          ${can('products.stock') ? `<button class="btn small" data-stock="${p.id}">المخزون</button>` : ''}
          ${can('products.delete') ? `<button class="btn small" data-archive="${p.id}">${p.archived ? 'إرجاع' : 'إخفاء'}</button>
          ${Number(p.orders_count) ? '' : `<button class="btn small danger" data-del-product="${p.id}">حذف</button>`}` : ''}
        </td></tr>`).join('')}
    </table></div>`);

  // Store and delivery company are saved with the "حفظ" button of the row (or
  // "حفظ الكل"); the product's open orders follow the new store and company.
  const changed = (tr) => [...tr.querySelectorAll('[data-product-field]')].filter((el) => el.value !== el.dataset.orig);
  const saveAll = main.querySelector('#save-all');
  const refresh = () => {
    let n = 0;
    main.querySelectorAll('tr[data-product]').forEach((tr) => {
      const dirty = changed(tr).length > 0;
      if (dirty) n += 1;
      tr.classList.toggle('dirty', dirty);
      tr.querySelector('.save-box')?.classList.toggle('hidden', !dirty);
    });
    if (saveAll) {
      saveAll.classList.toggle('hidden', !n);
      saveAll.textContent = `حفظ الكل (${n})`;
    }
  };
  const saveRows = async (rows) => {
    let orders = 0;
    for (const tr of rows) {
      const body = Object.fromEntries(changed(tr).map((el) => [el.dataset.productField, el.value || null]));
      orders += (await api('PUT', `/products/${tr.dataset.product}/store`, body)).orders || 0;
    }
    toast(orders ? `تم الحفظ، ${orders} طلبية تبعتو` : 'تم الحفظ');
    router();
  };
  main.querySelectorAll('[data-product-field]').forEach((el) => (el.onchange = refresh));
  main.querySelectorAll('[data-save]').forEach((b) => (b.onclick = guard(() => saveRows([b.closest('tr')]))));
  main.querySelectorAll('[data-cancel]').forEach((b) => (b.onclick = () => {
    changed(b.closest('tr')).forEach((el) => { el.value = el.dataset.orig; });
    refresh();
  }));
  if (saveAll) saveAll.onclick = guard(() => saveRows([...main.querySelectorAll('tr.dirty')]));
  main.querySelectorAll('[data-del-product]').forEach((b) => (b.onclick = guard(async () => {
    const p = products.find((x) => x.id === Number(b.dataset.delProduct));
    if (!confirm(`حذف "${p.name}"؟ ما يرجعش.`)) return;
    await api('DELETE', `/products/${p.id}`);
    toast('تحذف المنتج');
    router();
  })));
  main.querySelectorAll('[data-archive]').forEach((b) => (b.onclick = guard(async () => {
    const p = products.find((x) => x.id === Number(b.dataset.archive));
    await api('PUT', `/products/${p.id}/archive`, { archived: !p.archived });
    toast(p.archived ? 'رجع المنتج للقائمة' : 'تخبى المنتج، تلقاه في "المخفيين"');
    router();
  })));
  const byId = (id) => products.find((p) => p.id === Number(id));
  const add = main.querySelector('#add');
  if (add) add.onclick = () => productForm(null, stores);
  const link = main.querySelector('#link-stores');
  if (link) link.onclick = guard(() => linkStoresDialog(stores));
  const merge = main.querySelector('#merge-variants');
  if (merge) merge.onclick = guard(async () => {
    if (!confirm('نجمعو المنتجات اللي فيها المقاس/اللون في الاسم في منتج واحد؟')) return;
    const r = await api('POST', '/products/merge-variants');
    toast(r.merged.length ? `تجمعو ${r.merged.length} منتج` : 'ما كاش منتجات مكررة بالمتغير');
    router();
  });
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
      ${can('products.edit') ? '<button class="btn danger" data-regen>تغيير المفتاح</button>' : ''}
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
    <div class="bar"><button class="btn primary" id="add">+ بوتيك</button>
      ${isAdminUser() ? '<button class="btn" id="history" title="يقرا الطرود تاع العام اللي فات عند شركات التوصيل، باش التحقق (مستلمة/روتور) يحسب حتى القدام">جيب الداتا القديمة للتحقق</button>' : ''}
      <label>المنتجات الجديدة تروح لـ <select id="new-products"><option value="">— بلا بوتيك</option>
        ${stores.map((s) => `<option value="${s.id}" ${s.new_products ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label></div>
    <div class="table-wrap"><table>
      <tr><th>البوتيك</th><th>شركة التوصيل</th><th>الحسابات (التوكن)</th><th>استثناءات حسب الولاية</th><th>منتجات</th><th></th></tr>
      ${stores.map((s) => `<tr><td>${esc(s.name)}${s.new_products ? ' <span class="badge warn">المنتجات الجديدة</span>' : ''}</td><td>${esc(s.company_name || '— (حسب الولاية)')}</td>
        <td class="muted">${s.accounts.filter((a) => a.has_token).map((a) => `${esc(a.company_name)} ✓`).join('، ') || '<span class="neg">ما كاين حتى توكن</span>'}</td>
        <td class="muted">${s.routes.map((r) => `${wilaya(r.wilaya_code)} ← ${esc(r.company_name)}`).join('، ') || '—'}</td>
        <td class="num">${s.products_count}</td>
        <td><button class="btn small" data-edit="${s.id}">تعديل</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">زيد البوتيك الأولى</td></tr>'}
    </table></div>`);
  if (main.querySelector('#history')) main.querySelector('#history').onclick = guard(historyDialog);
  main.querySelector('#add').onclick = () => storeForm(null, companies);
  main.querySelector('#new-products').onchange = guard(async (e) => {
    await api('PUT', '/stores/new-products', { store_id: e.target.value });
    toast('تم الحفظ');
    router();
  });
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
  const [sheets, stores, direct] = await Promise.all([api('GET', '/sheets'), api('GET', '/stores'), api('GET', '/lightfunnels')]);
  const lfResult = new URLSearchParams(location.hash.split('?')[1] || '').get('lf');
  const eventLabel = { imported: 'دخلت', duplicate: 'مكررة', ignored: 'تجريبية', error: 'خطأ' };
  const main = shell(`
    <h2>الشيتات</h2>
    <div class="card">
      <h3>الربط المباشر مع LightFunnels</h3>
      <p class="muted">LightFunnels يبعث كل طلبية للـ ERP في نفس اللحظة، من غير شيت. تربط كل حساب مرة وحدة وتختار له البوتيك.</p>
      ${direct.configured ? '' : `<p class="neg">الموقع ما شافش ${direct.missing.map((k) => `<b dir="ltr">${k}</b>`).join(' و ')} في إعدادات Netlify. تأكد من الاسم بالضبط، ومن بعد Deploys ← Trigger deploy ← Deploy site.</p>`}
      ${lfResult === 'ok' ? '<p class="pos">تم الربط، ولات الطلبيات الجديدة تدخل وحدها.</p>' : lfResult === 'partial' ? '<p class="neg">تم الربط بصح تسجيل الطلبيات فشل، شوف الخطأ تحت.</p>' : ''}
      <div class="bar"><button class="btn primary" id="lf-add">+ ربط حساب LightFunnels</button></div>
      <div class="table-wrap"><table>
        <tr><th>الحساب</th><th>البوتيك</th><th>الحالة</th><th>دخلو</th><th>آخر طلبية</th><th>أخطاء</th><th></th></tr>
        ${direct.links.map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.store_name || '—')}</td>
          <td>${l.connected ? (l.webhooks ? '<span class="badge ok">مربوط</span>' : '<span class="badge warn">مربوط، بلا Webhooks</span>') : '<span class="badge warn">ما تربطش</span>'}</td>
          <td class="num">${l.imported_count}</td><td class="muted">${fmtDate(l.last_event_at) || '—'}</td>
          <td class="muted" style="white-space:pre-line;color:var(--danger)">${esc(l.last_error || '')}</td>
          <td class="actions"><a class="btn small primary" href="/api/lightfunnels/${l.id}/connect">${l.connected ? 'عاود الربط' : 'ربط'}</a>
            ${l.connected ? `<button class="btn small" data-lf-compare="${l.id}">قارن الطلبيات</button>` : ''}
            <button class="btn small danger" data-lf-del="${l.id}">حذف</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">ما كاين حتى ربط</td></tr>'}
      </table></div>
      ${direct.events.length ? `<details><summary class="muted">آخر الطلبيات اللي وصلت من LightFunnels</summary>
        <div class="table-wrap"><table><tr><th>الوقت</th><th>النوع</th><th>رقم LightFunnels</th><th>النتيجة</th></tr>
        ${direct.events.map((e) => `<tr><td class="muted">${fmtDate(e.created_at)}</td><td>${esc(e.topic)}</td><td dir="ltr">${esc(e.lf_order_id || '')}</td>
          <td>${eventLabel[e.status] || e.status}${e.error ? ` <span class="neg">${esc(e.error)}</span>` : ''}</td></tr>`).join('')}</table></div></details>` : ''}
    </div>
    <h3>الشيتات (احتياط)</h3>
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
  main.querySelector('#lf-add').onclick = () => lfForm(stores);
  main.querySelectorAll('[data-lf-compare]').forEach((b) => (b.onclick = () => lfCompare(Number(b.dataset.lfCompare))));
  main.querySelectorAll('[data-lf-del]').forEach((b) => (b.onclick = guard(async () => {
    if (!confirm('حذف الربط؟ الطلبيات اللي دخلت تبقى.')) return;
    await api('DELETE', `/lightfunnels/${b.dataset.lfDel}`);
    router();
  })));
  main.querySelector('#add').onclick = () => sheetForm(null, stores);
  main.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => sheetForm(sheets.find((g) => g.id === Number(b.dataset.edit)), stores)));
  main.querySelectorAll('[data-sync]').forEach((b) => (b.onclick = guard(async () => {
    b.disabled = true;
    const r = await api('POST', `/sheets/${b.dataset.sync}/sync`);
    toast(`دخلو ${r.imported} طلبية${r.errors.length ? `، ${r.errors.length} أخطاء` : ''}`, r.errors.length > 0);
    router();
  })));
}

// Compares the latest LightFunnels orders with the ERP, one by one, and brings in the missing ones.
function lfCompare(linkId) {
  const statusLabel = (st) => STATUS_LABELS[st] || st;
  const box = modal.open(`
    <h3>قارن الطلبيات مع LightFunnels</h3>
    <form class="bar" id="cmp-form">
      <input name="q" placeholder="اسم المنتج كيما في LightFunnels (مثلا: pyjama 5)" style="flex:1">
      <select name="pages"><option value="2">آخر 100 طلبية</option><option value="6" selected>آخر 300 طلبية</option><option value="10">آخر 500 طلبية</option></select>
      <button class="btn primary">قارن</button>
    </form>
    <div id="cmp-out" class="muted">اكتب اسم المنتج (ولا خليه فارغ باش تشوف كل الطلبيات) واضغط قارن.</div>
    <div class="actions"><button class="btn" type="button" data-close>غلق</button></div>`);
  const out = box.querySelector('#cmp-out');
  const run = async (doImport) => {
    const f = formData(box.querySelector('#cmp-form'));
    out.innerHTML = '<p class="muted">نقرا من LightFunnels…</p>';
    const r = await api('POST', `/lightfunnels/${linkId}/compare`, { q: f.q, pages: Number(f.pages), import: doImport });
    out.innerHTML = `
      <p>قريت <b>${r.scanned}</b> طلبية من LightFunnels${r.oldest ? ` (أقدم وحدة: ${esc(r.oldest)})` : ''}.
        فيهم <b>${r.matched}</b> فيها هذا المنتج: <span class="pos">${r.matched - r.missing} كاينين في الموقع</span>،
        <span class="${r.missing ? 'neg' : 'muted'}">${r.missing} ناقصين</span>${doImport ? `، دخلو دوكا ${r.imported}` : ''}.</p>
      ${r.missing && !doImport ? '<div class="bar"><button class="btn primary" id="cmp-import">دخّل الناقصين</button></div>' : ''}
      <div class="table-wrap" style="max-height:50vh;overflow:auto"><table>
        <tr><th>LightFunnels</th><th>الوقت</th><th>المنتج في LightFunnels</th><th>الهاتف</th><th>في الموقع</th></tr>
        ${r.rows.map((x) => `<tr><td dir="ltr">${esc(x.lf_name)}</td><td class="muted">${esc(x.created_at || '')}</td><td>${esc(x.items)}</td>
          <td dir="ltr">${esc(x.phone || '')}</td>
          <td>${x.order_id ? `<span class="pos">✅ ${esc(x.reference || String(x.order_id))}</span> · ${esc(statusLabel(x.status))} · ${esc(x.product || '')}${x.store ? ` <span class="muted">(${esc(x.store)})</span>` : ''}`
            : `<span class="neg">❌ ما كانش${x.error ? `: ${esc(x.error)}` : ''}</span>`}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">ما لقيت حتى طلبية بهذا الاسم</td></tr>'}
      </table></div>`;
    const imp = out.querySelector('#cmp-import');
    if (imp) imp.onclick = guard(async () => { imp.disabled = true; await run(true); });
  };
  box.querySelector('#cmp-form').onsubmit = guard(async (e) => { e.preventDefault(); await run(false); });
}

// A LightFunnels account is connected to one store; the products of its orders are matched in that store.
function lfForm(stores) {
  const box = modal.open(`
    <h3>ربط حساب LightFunnels</h3>
    <form class="stack" id="lf-form">
      <label>الاسم<input name="name" placeholder="yacine boutique" required></label>
      <label>البوتيك<select name="store_id"><option value="">—</option>${stores.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
      <p class="muted">من بعد "حفظ" تضغط "ربط": تتفتح صفحة LightFunnels، توافق على التطبيق وترجع للـ ERP.</p>
      <div class="actions"><button class="btn primary">حفظ</button><button class="btn" type="button" data-close>إلغاء</button></div>
    </form>`);
  box.querySelector('#lf-form').onsubmit = guard(async (e) => {
    e.preventDefault();
    await api('POST', '/lightfunnels', formData(e.target));
    modal.close();
    router();
  });
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
      <label>المنتج<select name="product_id" required>${products.filter((p) => !p.archived).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
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
// Ready-made sets of pages for the usual jobs; the boxes can still be changed one by one.
const CONFIRM_JOB = ['confirm', 'confirm.add', 'confirm.edit', 'confirm.price', 'confirm.delivery_price', 'confirm.company', 'confirm.confirm', 'confirm.fail', 'confirm.cancel'];
const TRACKING_JOB = ['tracking', 'tracking.edit', 'tracking.dispatch', 'tracking.back', 'tracking.cancel', 'tracking.delivered', 'tracking.returned', 'tracking.sync'];
const USER_PRESETS = [
  ['تأكيد', CONFIRM_JOB],
  ['سويفي', TRACKING_JOB],
  ['تأكيد + سويفي', [...CONFIRM_JOB, ...TRACKING_JOB]],
  ['محاسب', ['stats', 'dashboard', 'accounting', 'ads', 'products']],
];

// One box per page like Ecotrack's employee roles: the title box ticks the whole page,
// the first line opens the page and the others are what can be done in it.
function permissionBoxes(groups, checked) {
  return `<div class="perm-groups">${groups.map(([title, perms], i) => {
    const keys = Object.keys(perms);
    const all = keys.every((k) => checked.includes(k));
    return `<div class="perm-group">
      <label class="check perm-head"><input type="checkbox" data-group="${i}" ${all ? 'checked' : ''}> ${esc(title)}</label>
      <div class="perm-list">${keys.map((k, j) => `<label class="check ${j ? '' : 'perm-view'}">
        <input type="checkbox" name="perm" value="${k}" data-in="${i}" ${checked.includes(k) ? 'checked' : ''}> ${esc(perms[k])}</label>`).join('')}</div>
    </div>`;
  }).join('')}</div>`;
}

// The role menu and the page boxes, for adding or editing an account.
function bindPermissionForm(form) {
  const role = form.querySelector('[name=role]');
  const boxes = () => form.querySelectorAll('[name=perm]');
  const storesBox = form.querySelector('.perm-stores');
  // The stores list only matters for an accountant (profit page ticked, not admin).
  const groupBoxes = () => form.querySelectorAll('[data-group]');
  const inGroup = (i) => [...form.querySelectorAll(`[name=perm][data-in="${i}"]`)];
  const sync = () => {
    boxes().forEach((b) => { b.disabled = role.value === 'admin'; if (role.value === 'admin') b.checked = true; });
    groupBoxes().forEach((g) => { g.disabled = role.value === 'admin'; g.checked = inGroup(g.dataset.group).every((b) => b.checked); });
    const accounting = [...boxes()].some((b) => b.value === 'accounting' && b.checked);
    storesBox.classList.toggle('hidden', role.value === 'admin' || !accounting);
  };
  form.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.group) inGroup(el.dataset.group).forEach((b) => (b.checked = el.checked));
    else if (el.name === 'perm') {
      // An action needs its page; no page, no actions.
      const [view, ...actions] = inGroup(el.dataset.in);
      if (el === view && !el.checked) actions.forEach((b) => (b.checked = false));
      if (el !== view && el.checked) view.checked = true;
    } else return;
    sync();
  });
  role.onchange = sync;
  form.querySelectorAll('[data-preset]').forEach((btn) => (btn.onclick = () => {
    role.value = 'agent';
    const keys = USER_PRESETS[Number(btn.dataset.preset)][1];
    boxes().forEach((b) => { b.disabled = false; b.checked = keys.includes(b.value); });
    sync();
  }));
  sync();
  return () => {
    const permissions = [...boxes()].filter((b) => b.checked).map((b) => b.value);
    const stores = role.value === 'admin' || !permissions.includes('accounting') ? []
      : [...form.querySelectorAll('[name=store]:checked')].map((b) => Number(b.value));
    return { role: role.value, permissions, accounting_store_ids: stores };
  };
}

function permissionFields(groups, stores, user = { role: 'agent', permissions: [], accounting_store_ids: [] }) {
  const perms = Object.assign({}, ...groups.map(([, p]) => p));
  return `<label>النوع<select name="role"><option value="agent" ${user.role !== 'admin' ? 'selected' : ''}>عامل (يشوف غير الصفحات المكوشية)</option>
      <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>مدير (يشوف كلش ويزيد المستخدمين)</option></select></label>
    <div class="bar">${USER_PRESETS.map(([l], i) => `<button class="btn small" type="button" data-preset="${i}">${esc(l)}</button>`).join('')}</div>
    <div class="muted">واش يقدر يشوف ويخدم:</div>
    ${permissionBoxes(groups, user.role === 'admin' ? Object.keys(perms) : user.permissions)}
    <div class="perm-stores card">
      <div><b>البوتيكات اللي يحاسبهم</b> <span class="muted">(ما تكوشي حتى وحدة = يشوف كل البوتيكات)</span></div>
      <div class="perm-grid">${stores.map((st) => `<label class="check"><input type="checkbox" name="store" value="${st.id}"
        ${(user.accounting_store_ids || []).includes(st.id) ? 'checked' : ''}> ${esc(st.name)}</label>`).join('')}</div>
    </div>`;
}

async function usersPage() {
  const [{ users, groups }, stores] = await Promise.all([api('GET', '/users'), api('GET', '/stores')]);
  // What an account has, page by page: "قيد التأكيد (8/12)".
  const summary = (u) => groups.map(([title, perms]) => [title, Object.keys(perms).filter((k) => u.permissions.includes(k)).length, Object.keys(perms).length])
    .filter(([, n]) => n).map(([title, n, total]) => `${esc(title)}${total > 1 ? ` (${n}/${total})` : ''}`).join('، ');
  const storeName = (id) => stores.find((st) => st.id === id)?.name || `#${id}`;
  const main = shell(`
    <h2>المستخدمين</h2>
    <form class="card stack" id="user-form">
      <h3 style="margin:0">زيد مستخدم</h3>
      <div class="grid3">
        <label>اسم المستخدم<input name="username" required></label>
        <label>كلمة السر<input name="password" type="password" required minlength="6"></label>
      </div>
      ${permissionFields(groups, stores)}
      <div class="actions"><button class="btn primary">إضافة</button></div>
    </form>
    <div class="table-wrap"><table>
      <tr><th>الاسم</th><th>النوع</th><th>واش يشوف</th><th>تاريخ الإنشاء</th><th></th></tr>
      ${users.map((u) => `<tr><td>${esc(u.username)}</td><td>${roleLabel(u)}</td>
        <td class="muted">${u.role === 'admin' ? 'كلش' : summary(u) || '—'}
          ${u.role !== 'admin' && u.permissions.includes('accounting') ? `<div>الفايدة: ${u.accounting_store_ids.length ? u.accounting_store_ids.map((id) => esc(storeName(id))).join('، ') : 'كل البوتيكات'}</div>` : ''}</td>
        <td class="muted">${esc(fmtDate(u.created_at))}</td>
        <td class="actions"><button class="btn small" data-perms="${u.id}">الصلاحيات</button>
        <button class="btn small" data-pass="${u.id}">كلمة السر</button>
        ${u.id === state.user.id ? '' : `<button class="btn small danger" data-del="${u.id}">حذف</button>`}</td></tr>`).join('')}
    </table></div>`);
  const form = main.querySelector('#user-form');
  const read = bindPermissionForm(form);
  form.onsubmit = guard(async (e) => {
    e.preventDefault();
    await api('POST', '/users', { username: form.elements.username.value, password: form.elements.password.value, ...read() });
    toast('تزاد المستخدم');
    router();
  });
  main.querySelectorAll('[data-perms]').forEach((b) => (b.onclick = () => {
    const u = users.find((x) => x.id === Number(b.dataset.perms));
    const box = modal.open(`<h3>صلاحيات ${esc(u.username)}</h3>
      <form class="stack" id="perm-form">${permissionFields(groups, stores, u)}
        <div class="actions"><button class="btn primary">حفظ</button><button class="btn" type="button" data-close>إغلاق</button></div></form>`);
    const f = box.querySelector('#perm-form');
    const readEdit = bindPermissionForm(f);
    f.onsubmit = guard(async (e) => {
      e.preventDefault();
      await api('PUT', `/users/${u.id}/permissions`, readEdit());
      modal.close();
      toast('تم الحفظ');
      router();
    });
  }));
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
