require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

const SG_API   = process.env.SENDGROUND_API  || 'https://gocargo.dev.sendground.com';
const SG_TOKEN = process.env.SENDGROUND_TOKEN || '';
const SG_APP   = process.env.SENDGROUND_APP_ID || '23';

function sgHeaders() {
  return {
    'Content-Type':     'application/json',
    'Authorization':    `Bearer ${SG_TOKEN}`,
    'X-Application-Id': SG_APP,
  };
}

// ─── HEALTH ───────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, env: process.env.NODE_ENV }));

// ─── PROXY GENÉRICO GET a SendGround ──────
app.get('/api/sg/*', async (req, res) => {
  const path = req.params[0];
  const qs   = new URLSearchParams(req.query).toString();
  const url  = `${SG_API}/c1/${path}${qs ? '?' + qs : ''}`;
  try {
    const r = await fetch(url, { headers: sgHeaders() });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PROXY GENÉRICO POST a SendGround ─────
app.post('/api/sg/*', async (req, res) => {
  const path = req.params[0];
  const url  = `${SG_API}/c1/${path}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: sgHeaders(),
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PAGO CON DLOCAL ──────────────────────
app.post('/api/payment', async (req, res) => {
  const { cardToken, amount, currency, payerName, payerEmail, payerDocument, orderId, description } = req.body;
  if (!cardToken || !amount || !payerEmail) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }
  const xDate  = new Date().toISOString();
  const xLogin = process.env.DLOCAL_X_LOGIN || '';
  const payload = {
    amount: parseFloat(amount).toFixed(2),
    currency: currency || 'UYU',
    country: 'UY',
    payment_method_id: 'CARD',
    payment_method_flow: 'DIRECT',
    payer: { name: payerName || 'Cliente GoCargo', email: payerEmail, document: payerDocument || '' },
    card: { token: cardToken },
    order_id: orderId || `GC-${Date.now()}`,
    description: description || 'Envío GoCargo',
    notification_url: `${process.env.BACKEND_URL}/api/webhook/dlocal`,
  };
  const message = xLogin + xDate + JSON.stringify(payload);
  const hmac    = crypto.createHmac('sha256', process.env.DLOCAL_SECRET_KEY || '').update(message).digest('hex');
  try {
    const dlRes = await fetch(
      `${process.env.DLOCAL_API_URL || 'https://sandbox.dlocal.com'}/payments`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Date': xDate, 'X-Login': xLogin,
          'X-Trans-Key': process.env.DLOCAL_X_TRANS_KEY || '',
          'Authorization': `V2-HMAC-SHA256, Signature: ${hmac}`,
        },
        body: JSON.stringify(payload),
      }
    );
    const data = await dlRes.json();
    if (!dlRes.ok) return res.status(dlRes.status).json({ error: data.message || 'Error dLocal', detail: data });
    res.json({ paymentId: data.id, status: data.status, amount: data.amount, currency: data.currency });
  } catch(e) {
    res.status(500).json({ error: 'Error procesando pago: ' + e.message });
  }
});

// ─── WEBHOOK dLocal ───────────────────────
app.post('/api/webhook/dlocal', (req, res) => {
  console.log('dLocal webhook:', JSON.stringify(req.body));
  res.status(200).send('OK');
});

app.listen(PORT, () => console.log(`✅ GoCargo backend en :${PORT}`));
