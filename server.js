require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── CORS ─────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://pedidos.gocargo.com.uy',
  'https://gocargo-rastreo.netlify.app',
  'https://gocargo.com.uy',
  'https://go-cargo-pedidos-dec13.web.app',
  'https://go-cargo-pedidos-dec13.firebaseapp.com',
  'http://localhost:3000',
  'http://localhost:5000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.some(d => origin.includes(d.replace('https://', '').replace('http://', '')))) return cb(null, true);
    console.warn('CORS bloqueado:', origin);
    cb(new Error(`CORS bloqueado: ${origin}`));
  },
  credentials: true,
}));

// ─── BODY PARSING ─────────────────────────
app.use((req, res, next) => {
  if (req.path === '/api/webhook/dlocal') {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      req.rawBody = data;
      try { req.body = JSON.parse(data); } catch(e) { req.body = {}; }
      next();
    });
  } else {
    express.json()(req, res, next);
  }
});

// ─── VARIABLES DE ENTORNO ─────────────────
const SG_API         = (process.env.SENDGROUND_API || 'https://api.sendground.com').replace(/\/$/, '');
const SG_TOKEN       = process.env.SENDGROUND_TOKEN || '';
const SG_APP         = process.env.SENDGROUND_APP_ID || '23';
const SG_TOKEN_ADMIN = process.env.SENDGROUND_TOKEN_ADMIN || '';
const SG_APP_ADMIN   = '25';
const DL_API_KEY     = process.env.DLOCAL_API_KEY    || '';
const DL_SECRET_KEY  = process.env.DLOCAL_SECRET_KEY || '';
const FRONTEND_URL   = process.env.FRONTEND_URL || 'https://pedidos.gocargo.com.uy';
const BACKEND_URL    = (process.env.BACKEND_URL || '').replace(/\/$/, '');
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';

// ─── HEADERS SENGROUND ────────────────────
function sgHeaders() {
  return {
    'Content-Type':     'application/json',
    'Authorization':    `Bearer ${SG_TOKEN}`,
    'X-Application-Id': SG_APP,
    'Accept-Language':  'es',
  };
}
function sgAdminHeaders() {
  return {
    'Content-Type':     'application/json',
    'Authorization':    `Bearer ${SG_TOKEN_ADMIN}`,
    'X-Application-Id': SG_APP_ADMIN,
    'Accept-Language':  'es',
  };
}

// ─── RATE LIMITING ────────────────────────
const rateLimitMap = new Map();
function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    const entry = rateLimitMap.get(key) || { count: 0, start: now };
    if (now - entry.start > windowMs) { entry.count = 1; entry.start = now; }
    else entry.count++;
    rateLimitMap.set(key, entry);
    if (entry.count > maxRequests) return res.status(429).json({ error: 'Demasiadas solicitudes. Intentá de nuevo en unos minutos.' });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now - entry.start > 10 * 60 * 1000) rateLimitMap.delete(key);
  }
}, 10 * 60 * 1000);

// ─── PEDIDOS PENDIENTES ───────────────────
const PENDING_FILE = path.join('/tmp', 'pending_orders.json');
function loadPending() {
  try { if (fs.existsSync(PENDING_FILE)) return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); }
  catch(e) { console.error('Error loading pending:', e); }
  return {};
}
function savePending(data) {
  try { fs.writeFileSync(PENDING_FILE, JSON.stringify(data), 'utf8'); }
  catch(e) { console.error('Error saving pending:', e); }
}
let pendingOrders = loadPending();
function storePending(id, data) { pendingOrders[id] = { ...data, createdAt: new Date().toISOString() }; savePending(pendingOrders); }
function getPending(id)    { return pendingOrders[id] || null; }
function removePending(id) { delete pendingOrders[id]; savePending(pendingOrders); }

// ─── HEALTH ───────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// ─── RASTREO ─────────────────────────────
app.get('/api/track/:code', rateLimit(30, 60_000), async (req, res) => {
  const code = req.params.code;
  try {
    const r    = await fetch(`${SG_API}/c1/Orders/code/${encodeURIComponent(code)}`, { headers: sgAdminHeaders() });
    const text = await r.text();
    if (!r.ok) return res.status(404).json({ error: 'Pedido no encontrado' });
    try { res.json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON', raw: text.substring(0,300) }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── TIPOS DE PAQUETE ─────────────────────
app.get('/api/package-types', rateLimit(30, 60_000), async (req, res) => {
  const url = `${SG_API}/c1/Packages/Types?limit=50`;
  try {
    const r    = await fetch(url, { headers: sgHeaders() });
    const text = await r.text();
    try { res.status(r.status).json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON' }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── PRIORIDADES ─────────────────────────
app.get('/api/priorities', rateLimit(30, 60_000), async (req, res) => {
  const url = `${SG_API}/c1/Orders/Priorities?limit=20`;
  try {
    const r    = await fetch(url, { headers: sgHeaders() });
    const text = await r.text();
    try { res.status(r.status).json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON' }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── COTIZACIÓN ───────────────────────────
app.post('/api/quote', rateLimit(20, 60_000), async (req, res) => {
  const url = `${SG_API}/c1/Orders/Quotes`;
  try {
    const r    = await fetch(url, { method: 'POST', headers: sgHeaders(), body: JSON.stringify(req.body) });
    const text = await r.text();
    console.log(`Quote status: ${r.status} preview: ${text.substring(0,200)}`);
    try { res.status(r.status).json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON' }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── GEOCODIFICACIÓN ─────────────────────
app.get('/api/geocode', rateLimit(30, 60_000), async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'Falta el parámetro address' });
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_KEY}&language=es&region=UY`;
  try {
    const r    = await fetch(url);
    const text = await r.text();
    try { res.status(r.status).json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON' }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── DISTANCIA ───────────────────────────
app.get('/api/distance', rateLimit(30, 60_000), async (req, res) => {
  const { orig, dest } = req.query;
  if (!orig || !dest) return res.status(400).json({ error: 'orig y dest requeridos' });
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${orig}&destinations=${dest}&mode=driving&key=${GOOGLE_MAPS_KEY}`;
  try {
    const r    = await fetch(url);
    const data = await r.json();
    if (data.status === 'OK' && data.rows[0]?.elements[0]?.status === 'OK') {
      res.json({ km: data.rows[0].elements[0].distance.value / 1000 });
    } else {
      res.status(500).json({ error: 'Google Distance Matrix error', status: data.status });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── CUSTOMER ID ─────────────────────────
app.get('/api/customer-id', (req, res) => {
  try {
    const payload = JSON.parse(Buffer.from(SG_TOKEN.split('.')[1], 'base64').toString());
    res.json({ customerId: parseInt(payload.customerId) || 604 });
  } catch(e) { res.json({ customerId: 604 }); }
});

// ─── INICIAR PAGO ────────────────────────
app.post('/api/payment', rateLimit(10, 60_000), async (req, res) => {
  const { amount, currency, payerName, payerEmail, payerDocument, orderPayload, description } = req.body;
  if (!amount || !payerEmail || !orderPayload) return res.status(400).json({ error: 'Faltan campos requeridos' });
  if (!BACKEND_URL) return res.status(500).json({ error: 'Backend URL no configurada.' });
  if (!DL_API_KEY || !DL_SECRET_KEY) return res.status(500).json({ error: 'Credenciales de pago no configuradas.' });

  const dlocalOrderId = `GC-${Date.now()}-${Math.random().toString(36).substr(2,6)}`;
  storePending(dlocalOrderId, { orderPayload, amount, currency, payerName, payerEmail, payerDocument, description });

  const payload = {
    country:          'UY',
    currency:         currency || 'UYU',
    amount:           parseFloat(parseFloat(amount).toFixed(2)),
    order_id:         dlocalOrderId,
    notification_url: `${BACKEND_URL}/api/webhook/dlocal`,
    success_url:      `${FRONTEND_URL}?payment=success&order=${dlocalOrderId}`,
    back_url:         `${FRONTEND_URL}?payment=back`,
  };

  console.log('dLocal Go payload:', JSON.stringify(payload));
  const credentials = Buffer.from(`${DL_API_KEY}:${DL_SECRET_KEY}`).toString('base64');

  try {
    const dlRes = await fetch('https://api.dlocalgo.com/v1/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${credentials}` },
      body: JSON.stringify(payload),
    });
    const text = await dlRes.text();
    console.log('dLocal Go status:', dlRes.status, text.substring(0,300));
    let data;
    try { data = JSON.parse(text); } catch(e) { data = { error: text }; }
    if (!dlRes.ok) {
      removePending(dlocalOrderId);
      return res.status(dlRes.status).json({ error: data.message || data.error || 'Error dLocal Go', detail: data });
    }
    res.json({ paymentId: data.id, status: data.status, redirectUrl: data.redirect_url });
  } catch(e) {
    removePending(dlocalOrderId);
    res.status(500).json({ error: 'Error dLocal Go: ' + e.message });
  }
});

// ─── WEBHOOK dLocal ───────────────────────
app.post('/api/webhook/dlocal', async (req, res) => {
  res.status(200).send('OK');
  console.log('dLocal webhook body:', req.rawBody);

  const paymentId = req.body.payment_id || req.body.id;
  if (!paymentId) { console.log('Webhook sin payment_id, ignorado'); return; }

  console.log(`Consultando dLocal por payment_id=${paymentId}...`);
  const credentials = Buffer.from(`${DL_API_KEY}:${DL_SECRET_KEY}`).toString('base64');

  let order_id, status;
  try {
    const dlRes = await fetch(`https://api.dlocalgo.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Basic ${credentials}` }
    });
    const dlData = await dlRes.json();
    console.log('dLocal payment data:', JSON.stringify(dlData));
    order_id = dlData.order_id;
    status   = dlData.status;
  } catch(e) { console.error('Error consultando dLocal:', e.message); return; }

  console.log(`Webhook — order_id=${order_id} paymentId=${paymentId} status=${status}`);

  const PAID_STATUSES = ['PAID', 'APPROVED', 'paid', 'approved', 'COMPLETED', 'completed', 'SUCCESS', 'success'];
  if (!PAID_STATUSES.includes(status)) { console.log(`Webhook ignorado: status=${status}`); return; }

  const pending = getPending(order_id);
  if (!pending) { console.log(`Pedido pendiente no encontrado: ${order_id}`); return; }
  if (pending.sgOrder) { console.log(`Ya procesado: ${order_id}`); return; }

  console.log(`✅ Pago confirmado — creando pedido en SendGround...`);

  try {
    const r    = await fetch(`${SG_API}/c1/Orders`, {
      method: 'POST', headers: sgHeaders(), body: JSON.stringify(pending.orderPayload),
    });
    const data = await r.json();
    if (r.ok) {
      console.log(`✅ Pedido creado: ${data.code}`);
      pendingOrders[order_id] = { ...pending, sgOrder: { id: data.id, code: data.code, shippingLabelUrl: data.shippingLabelUrl || null }, paidAt: new Date().toISOString() };
      savePending(pendingOrders);
      setTimeout(() => removePending(order_id), 60 * 60 * 1000);
    } else {
      console.error(`❌ Error SendGround:`, JSON.stringify(data));
      pendingOrders[order_id] = { ...pending, sgError: JSON.stringify(data), errorAt: new Date().toISOString() };
      savePending(pendingOrders);
    }
  } catch(e) {
    console.error('Error creando pedido:', e.message);
    pendingOrders[order_id] = { ...pending, sgError: e.message, errorAt: new Date().toISOString() };
    savePending(pendingOrders);
  }
});

// ─── ESTADO DEL PEDIDO ────────────────────
app.get('/api/order/status/:dlocalOrderId', async (req, res) => {
  const pending = getPending(req.params.dlocalOrderId);
  if (pending?.sgOrder) return res.json({ status: 'CREATED', orderCode: pending.sgOrder.code, orderId: pending.sgOrder.id, shippingLabelUrl: pending.sgOrder.shippingLabelUrl || null });
  if (pending?.sgError) return res.json({ status: 'SG_ERROR', error: pending.sgError });
  if (pending) return res.json({ status: 'PENDING' });
  return res.json({ status: 'UNKNOWN' });
});

app.listen(PORT, () => console.log(`✅ GoCargo backend en :${PORT}`));
