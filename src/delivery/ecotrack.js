// Ecotrack platform adapter. Many Algerian delivery companies run on Ecotrack
// (each on its own subdomain, e.g. https://xxxx.ecotrack.dz), so one adapter
// covers all of them: only base_url and api_token change.

const STATUS_RULES = [
  [/retour|return|rtn/i, 'returned'],
  [/livr[ée]_|livr[ée]$|livr[ée] |encaiss|pay[ée]/i, 'delivered'],
];

export function mapEcotrackStatus(raw) {
  if (!raw) return null;
  if (/en.?livraison|vers.?wilaya|en.?transit/i.test(raw)) return 'dispatched';
  for (const [re, status] of STATUS_RULES) if (re.test(raw)) return status;
  return 'dispatched';
}

async function call(company, method, endpoint, params) {
  if (!company.base_url || !company.api_token) {
    throw new Error('Ecotrack: base_url et api_token sont obligatoires');
  }
  // base_url may be given with or without the /api/v1 suffix.
  const root = company.base_url.trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  const url = new URL(`${root}/api/v1/${endpoint}`);
  // Ecotrack expects the token as a query parameter, not a Bearer header.
  url.searchParams.set('api_token', company.api_token);
  const init = {
    method,
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  };
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(params);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || data.success === false) {
    const msg = data.message || data.error || JSON.stringify(data.errors || data).slice(0, 300);
    throw new Error(`Ecotrack ${res.status}: ${msg}`);
  }
  return data;
}

export const ecotrack = {
  async createShipment(company, order, product) {
    const data = await call(company, 'POST', 'create/order', {
      reference: order.reference,
      nom_client: order.customer_name,
      telephone: order.phone,
      telephone_2: order.phone2 || '',
      adresse: order.address || order.commune || '',
      commune: order.commune || '',
      code_wilaya: order.wilaya_code,
      montant: order.total,
      produit: `${product.name} x${order.quantity}`,
      remarque: order.notes || '',
      type: 1, // 1 = livraison
      stop_desk: order.stop_desk ? 1 : 0,
    });
    const tracking = data.tracking || data.data?.tracking;
    if (!tracking) throw new Error(`Ecotrack: pas de tracking dans la réponse (${JSON.stringify(data).slice(0, 200)})`);
    return { tracking };
  },

  async getStatus(company, tracking) {
    const data = await call(company, 'GET', 'get/tracking/info', { tracking });
    const activity = data.activity || data.data?.activity || [];
    const last = Array.isArray(activity) && activity.length ? activity[activity.length - 1] : null;
    const raw = data.status || data.data?.status || last?.status || last?.event || null;
    return { raw, status: mapEcotrackStatus(raw) };
  },
};
