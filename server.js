require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

const SG_API         = (process.env.SENDGROUND_API  || 'https://api.sendground.com').replace(/\/$/, '');
const SG_TOKEN       = process.env.SENDGROUND_TOKEN || '';
const SG_APP         = process.env.SENDGROUND_APP_ID || '23';
const SG_TOKEN_ADMIN = process.env.SENDGROUND_TOKEN_ADMIN || '';
const SG_APP_ADMIN   = '25';
const DL_API_KEY    = process.env.DLOCAL_API_KEY    || '';
const DL_SECRET_KEY = process.env.DLOCAL_SECRET_KEY || '';
const FRONTEND_URL  = process.env.FRONTEND_URL || 'https://pedidos.gocargo.com.uy';
const BACKEND_URL   = process.env.BACKEND_URL  || '';

// ─── PEDIDOS PENDIENTES (memoria + archivo) ─
const PENDING_FILE = path.join('/tmp', 'pending_orders.json');

function loadPending() {
  try {
    if (fs.existsSync(PENDING_FILE)) {
      return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    }
  } catch(e) { console.error('Error loading pending:', e); }
  return {};
}

function savePending(data) {
  try { fs.writeFileSync(PENDING_FILE, JSON.stringify(data), 'utf8'); }
  catch(e) { console.error('Error saving pending:', e); }
}

let pendingOrders = loadPending(); // { dlocalOrderId: { orderPayload, amount, ... } }

function storePending(dlocalOrderId, data) {
  pendingOrders[dlocalOrderId] = { ...data, createdAt: new Date().toISOString() };
  savePending(pendingOrders);
}

function getPending(dlocalOrderId) {
  return pendingOrders[dlocalOrderId] || null;
}

function removePending(dlocalOrderId) {
  delete pendingOrders[dlocalOrderId];
  savePending(pendingOrders);
}

function sgHeaders() {
  return {
    'Content-Type':     'application/json',
    'Authorization':    `Bearer ${SG_TOKEN}`,
    'X-Application-Id': SG_APP,
  };
}

function sgAdminHeaders() {
  return {
    'Content-Type':     'application/json',
    'Authorization':    `Bearer ${SG_TOKEN_ADMIN}`,
    'X-Application-Id': SG_APP_ADMIN,
  };
}

// ─── HEALTH ───────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, pending: Object.keys(pendingOrders).length }));

// ─── TRACKER — buscar pedido por código (token admin) ─
app.get('/api/track/:code', async (req, res) => {
  const code = req.params.code;
  try {
    const r    = await fetch(`${SG_API}/c1/Orders/code/${encodeURIComponent(code)}`, { headers: sgAdminHeaders() });
    const text = await r.text();
    if (!r.ok) return res.status(404).json({ error: 'Pedido no encontrado' });
    try { res.json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON', raw: text.substring(0,300) }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── PROXY GET a SendGround ───────────────
app.get('/api/sg/*', async (req, res) => {
  const path = req.params[0];
  const qs   = new URLSearchParams(req.query).toString();
  const url  = `${SG_API}/c1/${path}${qs ? '?' + qs : ''}`;
  try {
    const r    = await fetch(url, { headers: sgHeaders() });
    const text = await r.text();
    try { res.status(r.status).json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON', raw: text.substring(0,300) }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── PROXY POST a SendGround ──────────────
app.post('/api/sg/*', async (req, res) => {
  const sgPath = req.params[0];
  const url    = `${SG_API}/c1/${sgPath}`;
  try {
    const r    = await fetch(url, { method:'POST', headers: sgHeaders(), body: JSON.stringify(req.body) });
    const text = await r.text();
    try { res.status(r.status).json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON', raw: text.substring(0,300) }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── INICIAR PAGO (guarda pedido, genera link) ─
app.post('/api/payment', async (req, res) => {
  const { amount, currency, payerName, payerEmail, payerDocument, orderPayload, description } = req.body;

  if (!amount || !payerEmail || !orderPayload) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  // ID único para este intento de pago
  const dlocalOrderId = `GC-${Date.now()}-${Math.random().toString(36).substr(2,6)}`;

  // Guardar pedido pendiente
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
      removePending(dlocalOrderId); // Limpiar si falló
      return res.status(dlRes.status).json({ error: data.message || data.error || 'Error dLocal Go', detail: data });
    }

    res.json({ paymentId: data.id, status: data.status, redirectUrl: data.redirect_url });

  } catch(e) {
    removePending(dlocalOrderId);
    res.status(500).json({ error: 'Error dLocal Go: ' + e.message });
  }
});

// ─── WEBHOOK dLocal — crear pedido al confirmar pago ─
app.post('/api/webhook/dlocal', async (req, res) => {
  console.log('dLocal webhook FULL body:', JSON.stringify(req.body, null, 2));
  res.status(200).send('OK'); // Responder rápido a dLocal

  // dLocal solo manda payment_id — hay que consultar la API para obtener order_id y status
  const paymentId = req.body.payment_id || req.body.id;
  if (!paymentId) {
    console.log('Webhook sin payment_id, ignorado');
    return;
  }

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
  } catch(e) {
    console.error('Error consultando dLocal:', e.message);
    return;
  }

  console.log(`Webhook — order_id=${order_id} paymentId=${paymentId} status=${status}`);

  // Solo procesar pagos exitosos
  const PAID_STATUSES = ['PAID', 'APPROVED', 'paid', 'approved', 'COMPLETED', 'completed'];
  if (!PAID_STATUSES.includes(status)) {
    console.log(`Webhook ignorado: status=${status}`);
    return;
  }

  const pending = getPending(order_id);
  if (!pending) {
    console.log(`Pedido pendiente no encontrado: ${order_id}`);
    return;
  }

  console.log(`Pago confirmado ${paymentId} para ${order_id} — creando pedido en SendGround...`);

  try {
    const r = await fetch(`${SG_API}/c1/Orders`, {
      method: 'POST',
      headers: sgHeaders(),
      body: JSON.stringify(pending.orderPayload),
    });
    const data = await r.json();

    if (r.ok) {
      console.log(`✅ Pedido creado en SendGround: ${data.code || data.id}`);
      // Guardar datos del pedido de SendGround para que el frontend pueda consultarlos
      pendingOrders[order_id] = {
        ...pending,
        sgOrder: {
          id:               data.id,
          code:             data.code,
          shippingLabelUrl: data.shippingLabelUrl || null,
        },
        paidAt: new Date().toISOString(),
      };
      savePending(pendingOrders);
      // Limpiar después de 1 hora
      setTimeout(() => removePending(order_id), 60 * 60 * 1000);
    } else {
      console.error(`❌ Error creando pedido en SendGround:`, JSON.stringify(data));
    }
  } catch(e) {
    console.error('Error creando pedido en SendGround:', e.message);
  }
});

// ─── VERIFICAR ESTADO DEL PEDIDO (polling desde frontend) ─
app.get('/api/order/status/:dlocalOrderId', async (req, res) => {
  const { dlocalOrderId } = req.params;
  const pending = getPending(dlocalOrderId);

  if (pending?.sgOrder) {
    // Pedido ya creado en SendGround
    return res.json({
      status: 'CREATED',
      orderCode:       pending.sgOrder.code,
      orderId:         pending.sgOrder.id,
      shippingLabelUrl: pending.sgOrder.shippingLabelUrl || null,
    });
  }

  if (pending) {
    // Todavía pendiente
    return res.json({ status: 'PENDING' });
  }

  // No encontrado — puede que ya se procesó y se limpió
  return res.json({ status: 'UNKNOWN' });
});

app.listen(PORT, () => console.log(`✅ GoCargo backend en :${PORT}`));
