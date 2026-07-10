require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── CORS — solo dominios autorizados ────────
const ALLOWED_ORIGINS = [
  'https://pedidos.gocargo.com.uy',
  'https://gocargo-rastreo.netlify.app',
  'https://gocargo.com.uy',
  // desarrollo local
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];
app.use(cors({
  origin: (origin, cb) => {
    // Permitir requests sin origin (ej: curl, Postman, webhooks)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS bloqueado: ${origin}`));
  }
}));

// ─── BODY PARSING ────────────────────────────
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

// ─── VARIABLES DE ENTORNO ─────────────────────
const SG_API         = (process.env.SENDGROUND_API  || 'https://api.sendground.com').replace(/\/$/, '');
const SG_TOKEN       = process.env.SENDGROUND_TOKEN || '';
const SG_APP         = process.env.SENDGROUND_APP_ID || '23';
const SG_TOKEN_ADMIN = process.env.SENDGROUND_TOKEN_ADMIN || '';
const SG_APP_ADMIN   = '25';
const DL_API_KEY     = process.env.DLOCAL_API_KEY    || '';
const DL_SECRET_KEY  = process.env.DLOCAL_SECRET_KEY || '';
const FRONTEND_URL   = process.env.FRONTEND_URL || 'https://pedidos.gocargo.com.uy';
const BACKEND_URL    = (process.env.BACKEND_URL || '').replace(/\/$/, '');
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';

// ─── HEADERS SENGROUND ───────────────────────
function sgHeaders() {
  return {
    'Content-Type':     'application/json',
    'Authorization':    `Bearer ${SG_TOKEN}`,
    'X-Application-Id': SG_APP,
    'Accept-Language':  'es',
  };
}
function sgHeadersAdmin() {
  return {
    'Content-Type':     'application/json',
    'Authorization':    `Bearer ${SG_TOKEN_ADMIN}`,
    'X-Application-Id': SG_APP_ADMIN,
    'Accept-Language':  'es',
  };
}

// ─── PEDIDOS PENDIENTES (memoria + archivo) ──
const PENDING_FILE = path.join('/tmp', 'pending_orders.json');
function loadPending() {
  try {
    if (fs.existsSync(PENDING_FILE)) return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  } catch(e) { console.error('Error loading pending:', e); }
  return {};
}
function savePending(data) {
  try { fs.writeFileSync(PENDING_FILE, JSON.stringify(data), 'utf8'); }
  catch(e) { console.error('Error saving pending:', e); }
}
let pendingOrders = loadPending();
function storePending(id, data) {
  pendingOrders[id] = { ...data, createdAt: new Date().toISOString() };
  savePending(pendingOrders);
}
function getPending(id)    { return pendingOrders[id] || null; }
function removePending(id) { delete pendingOrders[id]; savePending(pendingOrders); }

// ─── HEALTH ──────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// ─── RASTREO ─────────────────────────────────
app.get('/api/track/:code', async (req, res) => {
  const { code } = req.params;
  const url = `${SG_API}/c1/Orders/code/${encodeURIComponent(code)}`;
  console.log('TRACK GET:', url);
  try {
    const r    = await fetch(url, { headers: sgHeadersAdmin() });
    const text = await r.text();
    try { res.status(r.status).json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON', raw: text.substring(0, 300) }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── TIPOS DE PAQUETE ────────────────────────
app.get('/api/package-types', async (req, res) => {
  const url = `${SG_API}/c1/Packages/Types?limit=50`;
  try {
    const r    = await fetch(url, { headers: sgHeaders() });
    const text = await r.text();
    try { res.status(r.status).json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON' }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── PRIORIDADES ─────────────────────────────
app.get('/api/priorities', async (req, res) => {
  const url = `${SG_API}/c1/Orders/Priorities?limit=20`;
  try {
    const r    = await fetch(url, { headers: sgHeaders() });
    const text = await r.text();
    try { res.status(r.status).json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON' }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── COTIZACIÓN ──────────────────────────────
app.post('/api/quote', async (req, res) => {
  const url = `${SG_API}/c1/Orders/Quotes`;
  try {
    const r    = await fetch(url, { method: 'POST', headers: sgHeaders(), body: JSON.stringify(req.body) });
    const text = await r.text();
    try { res.status(r.status).json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON' }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── GEOCODIFICACIÓN (proxy Google Maps) ─────
app.get('/api/geocode', async (req, res) => {
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

// ─── CUSTOMER ID (del token JWT) ─────────────
app.get('/api/customer-id', (req, res) => {
  try {
    const payload = JSON.parse(Buffer.from(SG_TOKEN.split('.')[1], 'base64').toString());
    res.json({ customerId: payload.customerId || '604' });
  } catch(e) {
    res.json({ customerId: '604' });
  }
});

// ─── INICIAR PAGO ────────────────────────────
app.post('/api/payment', async (req, res) => {
  const { amount, currency, payerName, payerEmail, payerDocument, orderPayload, description } = req.body;

  if (!amount || !payerEmail || !orderPayload) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  if (!BACKEND_URL) {
    console.error('ERROR: BACKEND_URL no configurada');
    return res.status(500).json({ error: 'Backend URL no configurada.' });
  }

  if (!DL_API_KEY || !DL_SECRET_KEY) {
    return res.status(500).json({ error: 'Credenciales de pago no configuradas.' });
  }

  const dlocalOrderId = `GC-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
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
    console.log('dLocal Go status:', dlRes.status, text.substring(0, 400));
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

// ─── WEBHOOK dLocal Go ───────────────────────
app.post('/api/webhook/dlocal', async (req, res) => {
  res.status(200).send('OK');
  console.log('=== WEBHOOK dLocal Go ===');
  console.log('Raw body:', req.rawBody);

  const body = req.body || {};
  let orderId, paymentId, status;

  if (body.payment && typeof body.payment === 'object') {
    orderId   = body.payment.order_id;
    paymentId = body.payment.id;
    status    = body.payment.status;
  } else {
    orderId   = body.order_id;
    paymentId = body.id || body.payment_id;
    status    = body.status;
  }

  console.log(`Webhook — orderId=${orderId} paymentId=${paymentId} status=${status}`);

  if (!orderId && paymentId) {
    try {
      const credentials = Buffer.from(`${DL_API_KEY}:${DL_SECRET_KEY}`).toString('base64');
      const dlRes = await fetch(`https://api.dlocalgo.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Basic ${credentials}` }
      });
      const dlData = JSON.parse(await dlRes.text());
      orderId = dlData.order_id;
      status  = dlData.status || status;
    } catch(e) { console.error('Error consultando dLocal Go:', e.message); }
  }

  if (!orderId) { console.log('Webhook sin order_id'); return; }

  const PAID_STATUSES = ['PAID', 'paid', 'APPROVED', 'approved', 'COMPLETED', 'completed', 'SUCCESS', 'success'];
  if (!PAID_STATUSES.includes(String(status))) {
    console.log(`Webhook ignorado — status="${status}"`);
    return;
  }

  const pending = getPending(orderId);
  if (!pending) { console.log(`Pendiente no encontrado: ${orderId}`); return; }
  if (pending.sgOrder) { console.log(`Ya procesado: ${orderId}`); return; }

  console.log(`✅ Pago confirmado — creando pedido en SendGround...`);

  let correctCustomerId = 604;
  try {
    const tokenPayload = JSON.parse(Buffer.from(SG_TOKEN.split('.')[1], 'base64').toString());
    if (tokenPayload.customerId) correctCustomerId = parseInt(tokenPayload.customerId);
  } catch(e) { console.warn('No se pudo extraer customerId:', e.message); }

  const orderPayload = { ...pending.orderPayload, customerId: correctCustomerId };

  try {
    const r = await fetch(`${SG_API}/c1/Orders`, {
      method: 'POST', headers: sgHeaders(), body: JSON.stringify(orderPayload),
    });
    const text = await r.text();
    console.log(`SG create order — status=${r.status}`);
    let data;
    try { data = JSON.parse(text); } catch(e) { data = {}; }
    if (r.ok) {
      console.log(`✅ Pedido creado — code=${data.code}`);
      pendingOrders[orderId] = { ...pending, sgOrder: { id: data.id, code: data.code, shippingLabelUrl: data.shippingLabelUrl || null }, paidAt: new Date().toISOString() };
      savePending(pendingOrders);
      setTimeout(() => removePending(orderId), 2 * 60 * 60 * 1000);
    } else {
      console.error(`❌ Error SendGround (${r.status}):`, text.substring(0, 500));
      pendingOrders[orderId] = { ...pending, sgError: text.substring(0, 500), errorAt: new Date().toISOString() };
      savePending(pendingOrders);
    }
  } catch(e) {
    console.error('❌ Excepción:', e.message);
    pendingOrders[orderId] = { ...pending, sgError: e.message, errorAt: new Date().toISOString() };
    savePending(pendingOrders);
  }
});

// ─── ESTADO DEL PEDIDO ───────────────────────
app.get('/api/order/status/:orderId', async (req, res) => {
  const pending = getPending(req.params.orderId);
  if (!pending)        return res.json({ status: 'UNKNOWN' });
  if (pending.sgOrder) return res.json({ status: 'CREATED', orderCode: pending.sgOrder.code, orderId: pending.sgOrder.id, shippingLabelUrl: pending.sgOrder.shippingLabelUrl || null });
  if (pending.sgError) return res.json({ status: 'SG_ERROR', error: pending.sgError });
  return res.json({ status: 'PENDING' });
});

app.listen(PORT, () => console.log(`✅ GoCargo backend en :${PORT}`));
