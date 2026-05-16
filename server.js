require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

const SG_API   = (process.env.SENDGROUND_API  || 'https://api.dev.sendground.com').replace(/\/$/, '');
const SG_TOKEN = process.env.SENDGROUND_TOKEN || '';
const SG_APP   = process.env.SENDGROUND_APP_ID || '23';

// dLocal Go credentials
const DL_API_KEY    = process.env.DLOCAL_API_KEY    || '';
const DL_SECRET_KEY = process.env.DLOCAL_SECRET_KEY || '';
const DL_API_URL    = process.env.DLOCAL_API_URL    || 'https://api.dlocal.com';

function sgHeaders() {
  return {
    'Content-Type':     'application/json',
    'Authorization':    `Bearer ${SG_TOKEN}`,
    'X-Application-Id': SG_APP,
  };
}

// dLocal Go signature: HMAC-SHA256(apiKey + date + requestBody, secretKey)
function dlSignature(body) {
  const date    = new Date().toISOString();
  const message = DL_API_KEY + date + (body || '');
  const sig     = crypto.createHmac('sha256', DL_SECRET_KEY).update(message).digest('hex');
  return { date, sig };
}

// ─── HEALTH ───────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// ─── PROXY GET a SendGround ───────────────
app.get('/api/sg/*', async (req, res) => {
  const path = req.params[0];
  const qs   = new URLSearchParams(req.query).toString();
  const url  = `${SG_API}/c1/${path}${qs ? '?' + qs : ''}`;
  try {
    const r    = await fetch(url, { headers: sgHeaders() });
    const text = await r.text();
    try { res.status(r.status).json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON from SG', raw: text.substring(0,300) }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── PROXY POST a SendGround ──────────────
app.post('/api/sg/*', async (req, res) => {
  const path = req.params[0];
  const url  = `${SG_API}/c1/${path}`;
  try {
    const r    = await fetch(url, { method:'POST', headers: sgHeaders(), body: JSON.stringify(req.body) });
    const text = await r.text();
    try { res.status(r.status).json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON from SG', raw: text.substring(0,300) }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── CREAR LINK DE PAGO dLocal Go ─────────
app.post('/api/payment', async (req, res) => {
  const { amount, currency, payerName, payerEmail, payerDocument, orderId, description, returnUrl } = req.body;

  if (!amount || !payerEmail) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  const payload = {
    amount:      parseFloat(amount).toFixed(2),
    currency:    currency || 'UYU',
    country:     'UY',
    payment_method_flow: 'REDIRECT',
    payer: {
      name:     payerName || 'Cliente GoCargo',
      email:    payerEmail,
      document: payerDocument || '',
    },
    order_id:          orderId    || `GC-${Date.now()}`,
    description:       description || 'Envío GoCargo',
    success_url:       returnUrl || `${process.env.BACKEND_URL}/payment/success`,
    back_url:          returnUrl || `${process.env.BACKEND_URL}/payment/back`,
    notification_url:  `${process.env.BACKEND_URL}/api/webhook/dlocal`,
  };

  const bodyStr = JSON.stringify(payload);
  const { date, sig } = dlSignature(bodyStr);

  try {
    const dlRes = await fetch(`${DL_API_URL}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'X-Date':        date,
        'X-Login':       DL_API_KEY,
        'X-Trans-Key':   DL_SECRET_KEY,
        'Authorization': `V2-HMAC-SHA256, Signature: ${sig}`,
      },
      body: bodyStr,
    });
    const data = await dlRes.json();
    if (!dlRes.ok) return res.status(dlRes.status).json({ error: data.message || 'Error dLocal', detail: data });

    // Devolver el link de pago
    res.json({
      paymentId:   data.id,
      status:      data.status,
      redirectUrl: data.redirect_url, // URL a donde redirigir al cliente
      amount:      data.amount,
      currency:    data.currency,
    });
  } catch(e) {
    res.status(500).json({ error: 'Error dLocal: ' + e.message });
  }
});

// ─── WEBHOOK dLocal ───────────────────────
app.post('/api/webhook/dlocal', (req, res) => {
  console.log('dLocal webhook:', JSON.stringify(req.body));
  res.status(200).send('OK');
});

// ─── PÁGINAS DE RETORNO ───────────────────
app.get('/payment/success', (_, res) => {
  res.send(`<html><body><script>
    window.opener?.postMessage({type:'PAYMENT_SUCCESS'}, '*');
    window.close();
  </script><p>Pago exitoso. Podés cerrar esta ventana.</p></body></html>`);
});

app.get('/payment/back', (_, res) => {
  res.send(`<html><body><script>
    window.opener?.postMessage({type:'PAYMENT_BACK'}, '*');
    window.close();
  </script><p>Pago cancelado.</p></body></html>`);
});

app.listen(PORT, () => console.log(`✅ GoCargo backend en :${PORT}`));
