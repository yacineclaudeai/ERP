// E-com Delivery ("My Ecom Delivery", ecom-dz.com) API v2. Not Ecotrack: each
// request carries the store's KEY and Token in the X-API-Key / X-API-Token headers.
// Creation answers 201 even when the parcel is refused: the result of each line says.

const BASE = 'https://ecom-dz.com/api_v2';

// id_situation: 7 Livrée, 14 Encaisser, 15 Recouvert = delivered; 5 Annuler, 6 Annuler x3 = failed (comes back).
export function mapEcomSituation(id) {
  const n = Number(id);
  if ([7, 14, 15].includes(n)) return 'delivered';
  if ([5, 6].includes(n)) return 'returned';
  return n ? 'dispatched' : null;
}

async function call(company, method, path, { query = {}, body, timeout = 20_000 } = {}) {
  if (!company.api_key || !company.api_token) throw new Error('My Ecom: KEY و Token لازم يتحطو في صفحة البوتيكات');
  const root = (company.base_url || BASE).trim().replace(/\/+$/, '');
  const url = new URL(`${root}${path}`);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'X-API-Key': company.api_key,
      'X-API-Token': company.api_token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const e = data.error || {};
    const details = Array.isArray(e.details) ? ` (${e.details.map((d) => `${d.champ}: ${d.raison}`).join(', ')})` : '';
    throw new Error(`My Ecom ${res.status}: ${e.message || e.code || JSON.stringify(data).slice(0, 200)}${details}`);
  }
  return data;
}

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim();

// The commune must be one of the company's names for the wilaya: pick the closest one.
async function communeName(company, wilaya, commune) {
  if (!commune) return commune;
  const list = await call(company, 'GET', '/communes', { query: { id_wilaya: wilaya } }).catch(() => []);
  const want = fold(commune);
  const names = (Array.isArray(list) ? list : []).map((c) => c.commune).filter(Boolean);
  return names.find((n) => fold(n) === want) || names.find((n) => fold(n).startsWith(want) || want.startsWith(fold(n))) || commune;
}

// Stop desk: the office in the order's commune, else the wilaya's first one.
async function stopdeskCode(company, wilaya, commune) {
  const list = await call(company, 'GET', '/stopdesks', { query: { id_wilaya: wilaya } });
  const offices = Array.isArray(list) ? list : [];
  const want = fold(commune);
  const office = (want && offices.find((o) => fold(o.commune) === want || fold(o.nom_bureau) === want)) || offices[0];
  if (!office) throw new Error(`My Ecom: ما كاش stop desk في الولاية ${wilaya}`);
  return office.code_stopdesk;
}

const cut = (s, n) => String(s ?? '').slice(0, n);

export const myecom = {
  async createShipment(company, order, product) {
    const article = [`${product.name} x${order.quantity}`, ...(order.items || []).map((i) => `${i.product_name} x${i.quantity}`)].join(' + ');
    const parcel = {
      nom_complet: cut(order.customer_name, 60),
      mobile_1: order.phone,
      id_wilaya: order.wilaya_code,
      article: cut(article, 255),
      quantite: order.quantity || 1,
      total: order.total,
      stopdesk: order.stop_desk ? 1 : 0,
      adresse: cut(order.address || '', 100),
      note_fournisseur: cut([order.variant, order.notes].filter(Boolean).join(' | '), 255),
      id_externe: cut(order.reference, 20),
    };
    if (order.phone2) parcel.mobile_2 = order.phone2;
    if (order.stop_desk) parcel.code_stopdesk = await stopdeskCode(company, order.wilaya_code, order.commune);
    else parcel.commune = await communeName(company, order.wilaya_code, order.commune);
    const data = await call(company, 'POST', '/colis', { body: [parcel] });
    const line = data.resultats?.[0];
    if (!line?.ok || !line.tracking) throw new Error(`My Ecom: ${line?.erreur || JSON.stringify(data).slice(0, 200)}`);
    return { tracking: line.tracking };
  },

  // One page (100 parcels) of the parcels created between start and end, newest first.
  async listParcels(company, start, end, page = 1) {
    const day = (d) => d.toISOString().slice(0, 10);
    const data = await call(company, 'GET', '/colis', {
      query: { page, limit: 100, date_debut: day(start), date_fin: day(end), type_date: 'creation' }, timeout: 50_000,
    });
    const items = Array.isArray(data.items) ? data.items : [];
    const outcome = (s) => { const m = mapEcomSituation(s); return m === 'dispatched' ? null : m; };
    return {
      parcels: items.map((r) => ({ tracking: r.tracking, products: r.article ?? '', phone: r.mobile ?? null, outcome: outcome(r.id_situation) })),
      // total_pages only comes with page 1; a full page means there may be another one.
      last_page: Number(data.total_pages) || (items.length === 100 ? page + 1 : page),
    };
  },

  // Only while the parcel is still being prepared; afterwards My Ecom answers 409.
  async cancelShipment(company, tracking) {
    await call(company, 'DELETE', `/colis/${encodeURIComponent(tracking)}`);
  },

  async getStatus(company, tracking) {
    const data = await call(company, 'GET', `/colis/${encodeURIComponent(tracking)}`);
    return { raw: data.situation || data.etat_logistique || null, status: mapEcomSituation(data.id_situation) };
  },
};
