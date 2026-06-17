require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
// IMPORTANTE: el webhook de dLocal necesita el body raw para verificar firma
// Usamos express.json() globalmente pero con manejo especial para el webhook
app.use((req, res, next) => {
  if (req.path === '/api/webhook/dlocal') {
    // Capturar raw body para logs y verificación futura
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

const SG_API   = (process.env.SENDGROUND_API  || 'https://api.sendground.com').replace(/\/$/, '');
const SG_TOKEN = process.env.SENDGROUND_TOKEN || '';
const SG_APP   = process.env.SENDGROUND_APP_ID || '23';
const DL_API_KEY    = process.env.DLOCAL_API_KEY    || '';
const DL_SECRET_KEY = process.env.DLOCAL_SECRET_KEY || '';
const FRONTEND_URL  = process.env.FRONTEND_URL || 'https://pedidos.gocargo.com.uy';
const BACKEND_URL   = (process.env.BACKEND_URL || '').replace(/\/$/, '');

// ─── PEDIDOS PENDIENTES (memoria + archivo) ─
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

function sgHeaders() {
  return {
    'Content-Type':     'application/json',
    'Authorization':    `Bearer ${SG_TOKEN}`,
    'X-Application-Id': SG_APP,
    'Accept-Language':  'es',
  };
}

// ─── RASTREO DE PEDIDOS (token admin) ───────
const SG_TOKEN_ADMIN = process.env.SENDGROUND_TOKEN_ADMIN || '';
const SG_APP_ADMIN   = '25';

function sgHeadersAdmin() {
  return {
    'Content-Type':     'application/json',
    'Authorization':    `Bearer ${SG_TOKEN_ADMIN}`,
    'X-Application-Id': SG_APP_ADMIN,
    'Accept-Language':  'es',
  };
}

app.get('/api/track/:code', async (req, res) => {
  const { code } = req.params;
  const url = `${SG_API}/c1/Orders/code/${code}`;
  console.log('TRACK GET:', url);
  try {
    const r    = await fetch(url, { headers: sgHeadersAdmin() });
    const text = await r.text();
    try { res.status(r.status).json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON', raw: text.substring(0,300) }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── HEALTH ───────────────────────────────
app.get('/health', (_, res) => res.json({
  ok: true,
  pending: Object.keys(pendingOrders).length,
  backend_url: BACKEND_URL,
  sg_api: SG_API,
  has_dl_key: !!DL_API_KEY,
}));

// ─── PROXY GET SendGround ─────────────────
app.get('/api/sg/*', async (req, res) => {
  const sgPath = req.params[0];
  const qs     = new URLSearchParams(req.query).toString();
  const url    = `${SG_API}/c1/${sgPath}${qs ? '?' + qs : ''}`;
  console.log('SG GET:', url);
  try {
    const r    = await fetch(url, { headers: sgHeaders() });
    const text = await r.text();
    try { res.status(r.status).json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON', raw: text.substring(0,300) }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── PROXY POST SendGround ────────────────
app.post('/api/sg/*', async (req, res) => {
  const sgPath = req.params[0];
  const url    = `${SG_API}/c1/${sgPath}`;
  console.log('SG POST:', url);
  try {
    const r    = await fetch(url, { method:'POST', headers: sgHeaders(), body: JSON.stringify(req.body) });
    const text = await r.text();
    console.log(`SG POST status: ${r.status} preview: ${text.substring(0,200)}`);
    try { res.status(r.status).json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON', raw: text.substring(0,300) }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── INICIAR PAGO ─────────────────────────
app.post('/api/payment', async (req, res) => {
  const { amount, currency, payerName, payerEmail, payerDocument, orderPayload, description } = req.body;

  if (!amount || !payerEmail || !orderPayload) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  const dlocalOrderId = `GC-${Date.now()}-${Math.random().toString(36).substr(2,6)}`;

  // Verificar que BACKEND_URL esté configurada
  if (!BACKEND_URL) {
    console.error('ERROR: BACKEND_URL no está configurada en las variables de entorno');
    return res.status(500).json({ error: 'Backend URL no configurada. Contactá al administrador.' });
  }

  storePending(dlocalOrderId, { orderPayload, amount, currency, payerName, payerEmail, payerDocument, description });

  const notificationUrl = `${BACKEND_URL}/api/webhook/dlocal`;
  const successUrl      = `${FRONTEND_URL}?payment=success&order=${dlocalOrderId}`;
  const backUrl         = `${FRONTEND_URL}?payment=back`;

  const payload = {
    country:          'UY',
    currency:         currency || 'UYU',
    amount:           parseFloat(parseFloat(amount).toFixed(2)),
    order_id:         dlocalOrderId,
    notification_url: notificationUrl,
    success_url:      successUrl,
    back_url:         backUrl,
  };

  console.log('dLocal Go payload:', JSON.stringify(payload));
  console.log('Webhook URL:', notificationUrl);

  const credentials = Buffer.from(`${DL_API_KEY}:${DL_SECRET_KEY}`).toString('base64');

  try {
    const dlRes = await fetch('https://api.dlocalgo.com/v1/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${credentials}` },
      body: JSON.stringify(payload),
    });

    const text = await dlRes.text();
    console.log('dLocal Go status:', dlRes.status, text.substring(0,400));

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

// ─── WEBHOOK dLocal Go ────────────────────
// dLocal Go manda el body directamente con id, order_id y status
app.post('/api/webhook/dlocal', async (req, res) => {
  // Responder 200 inmediatamente para que dLocal no reintente
  res.status(200).send('OK');

  console.log('=== WEBHOOK dLocal Go ===');
  console.log('Raw body:', req.rawBody);
  console.log('Parsed body:', JSON.stringify(req.body, null, 2));

  const body = req.body || {};

  // dLocal Go puede mandar los datos en distintos formatos:
  // Formato A: { id, order_id, status, ... }
  // Formato B: { payment: { id, order_id, status } }
  // Formato C: { payment_id, order_id, status }
  let orderId, paymentId, status;

  if (body.payment && typeof body.payment === 'object') {
    // Formato B
    orderId   = body.payment.order_id;
    paymentId = body.payment.id;
    status    = body.payment.status;
  } else {
    // Formato A / C
    orderId   = body.order_id;
    paymentId = body.id || body.payment_id;
    status    = body.status;
  }

  console.log(`Webhook — orderId=${orderId} paymentId=${paymentId} status=${status}`);

  // Si no tenemos order_id pero sí payment_id, intentar consultarle a dLocal Go
  if (!orderId && paymentId) {
    console.log(`Sin order_id, consultando dLocal Go por payment_id=${paymentId}...`);
    try {
      const credentials = Buffer.from(`${DL_API_KEY}:${DL_SECRET_KEY}`).toString('base64');
      const dlRes = await fetch(`https://api.dlocalgo.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Basic ${credentials}` }
      });
      const text = await dlRes.text();
      console.log('dLocal Go payment detail:', text.substring(0,400));
      const dlData = JSON.parse(text);
      orderId = dlData.order_id;
      status  = dlData.status || status;
    } catch(e) {
      console.error('Error consultando dLocal Go:', e.message);
    }
  }

  if (!orderId) {
    console.log('Webhook sin order_id — no se puede procesar');
    return;
  }

  // Verificar estado de pago
  const PAID_STATUSES = ['PAID', 'paid', 'APPROVED', 'approved', 'COMPLETED', 'completed', 'SUCCESS', 'success'];
  if (!PAID_STATUSES.includes(String(status))) {
    console.log(`Webhook ignorado — status="${status}" no es un pago exitoso`);
    return;
  }

  const pending = getPending(orderId);
  if (!pending) {
    console.log(`Pedido pendiente no encontrado para orderId=${orderId}`);
    // Listar los pendientes para debug
    console.log('Pendientes actuales:', Object.keys(pendingOrders));
    return;
  }

  // Ya fue procesado antes?
  if (pending.sgOrder) {
    console.log(`Pedido ${orderId} ya fue creado en SendGround (${pending.sgOrder.code}), ignorando webhook duplicado`);
    return;
  }

  console.log(`✅ Pago confirmado para ${orderId} — creando pedido en SendGround...`);

  // Siempre usar el customerId del token JWT, ignorar lo que vino del frontend
  let correctCustomerId = 604; // fallback producción
  try {
    const tokenPayload = JSON.parse(Buffer.from(SG_TOKEN.split('.')[1], 'base64').toString());
    if (tokenPayload.customerId) correctCustomerId = parseInt(tokenPayload.customerId);
  } catch(e) { console.warn('No se pudo extraer customerId del token:', e.message); }

  const orderPayload = { ...pending.orderPayload, customerId: correctCustomerId };
  console.log(`Usando customerId=${correctCustomerId} (del token JWT)`);
  console.log('OrderPayload:', JSON.stringify(orderPayload, null, 2));

  try {
    const r = await fetch(`${SG_API}/c1/Orders`, {
      method:  'POST',
      headers: sgHeaders(),
      body:    JSON.stringify(orderPayload),
    });
    const text = await r.text();
    console.log(`SG create order — status=${r.status} body=${text.substring(0,400)}`);

    let data;
    try { data = JSON.parse(text); } catch(e) { data = {}; }

    if (r.ok) {
      console.log(`✅ Pedido creado en SendGround — code=${data.code} id=${data.id}`);
      pendingOrders[orderId] = {
        ...pending,
        sgOrder: {
          id:               data.id,
          code:             data.code,
          shippingLabelUrl: data.shippingLabelUrl || null,
        },
        paidAt: new Date().toISOString(),
      };
      savePending(pendingOrders);
      // Limpiar después de 2 horas
      setTimeout(() => removePending(orderId), 2 * 60 * 60 * 1000);
    } else {
      console.error(`❌ Error creando pedido en SendGround (${r.status}):`, text.substring(0,500));
      // Guardar el error para que el polling lo detecte
      pendingOrders[orderId] = { ...pending, sgError: text.substring(0,500), errorAt: new Date().toISOString() };
      savePending(pendingOrders);
    }
  } catch(e) {
    console.error('❌ Excepción creando pedido en SendGround:', e.message);
    pendingOrders[orderId] = { ...pending, sgError: e.message, errorAt: new Date().toISOString() };
    savePending(pendingOrders);
  }
});

// ─── ESTADO DEL PEDIDO (polling desde frontend) ─
app.get('/api/order/status/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const pending = getPending(orderId);

  if (!pending) {
    return res.json({ status: 'UNKNOWN' });
  }

  if (pending.sgOrder) {
    return res.json({
      status:          'CREATED',
      orderCode:        pending.sgOrder.code,
      orderId:          pending.sgOrder.id,
      shippingLabelUrl: pending.sgOrder.shippingLabelUrl || null,
    });
  }

  if (pending.sgError) {
    // El webhook llegó pero SendGround rechazó el pedido
    return res.json({ status: 'SG_ERROR', error: pending.sgError });
  }

  // Todavía esperando el webhook de dLocal
  return res.json({ status: 'PENDING' });
});

app.listen(PORT, () => console.log(`✅ GoCargo backend en :${PORT}`));
