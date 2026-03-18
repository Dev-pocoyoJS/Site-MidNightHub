/**
 * MidNightHub — Firebase Cloud Functions
 *
 * COMO INSTALAR:
 * 1. npm install -g firebase-tools
 * 2. firebase login
 * 3. firebase init functions  (projeto: midnighthub-24ded)
 * 4. Substitua functions/index.js por este arquivo
 * 5. cd functions && npm install node-fetch
 * 6. Configure sua Luarmor API Key (pegue em luarmor.net → Profile):
 *    firebase functions:config:set luarmor.api_key="SUA_KEY_AQUI"
 *    firebase functions:config:set mp.token="APP_USR-SEU_TOKEN_MP"
 *    firebase functions:config:set admin.token="midnighthub-admin-2026"
 * 7. firebase deploy --only functions
 */

const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const fetch     = require('node-fetch');

admin.initializeApp();
const db = admin.firestore();

const LUARMOR_PROJECT_ID = 'be96dbada933c2cce01bf0e9d2d49f52';
const LUARMOR_SCRIPT_ID  = 'd50d096921fc3d6157990616b5c64e97';

// ── CORS helper ──────────────────────────────────────────────
function cors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
}

// ── checkLuarmorKey ──────────────────────────────────────────
// GET ?key=XXXX  →  { success, user }
exports.checkLuarmorKey = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const key = req.query.key;
  if (!key) { res.json({ success: false, error: 'Key não informada.' }); return; }

  const apiKey = functions.config().luarmor?.api_key;
  if (!apiKey) { res.json({ success: false, error: 'Luarmor API Key não configurada no servidor.' }); return; }

  try {
    const r = await fetch(
      `https://api.luarmor.net/v3/projects/${LUARMOR_PROJECT_ID}/users?user_key=${encodeURIComponent(key)}`,
      { headers: { Authorization: apiKey, 'Content-Type': 'application/json' } }
    );
    const data = await r.json();

    if (!data.success || !data.users?.length) {
      res.json({ success: false, error: 'Key não encontrada.' }); return;
    }

    const user = data.users[0];

    // Cache no Firebase pra próximos logins serem instantâneos
    await db.collection('keys').doc(key).set({
      key, luarmor_key: user.user_key || key,
      status: user.banned ? 'banned' : (user.status || 'active'),
      expires_at: user.auth_expire ?? -1,
      total_executions: user.total_executions || 0,
      hwid: user.identifier || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ success: true, user });

  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: 'Erro interno. Tente novamente.' });
  }
});

// ── resetHwid ────────────────────────────────────────────────
// POST { key }  →  { success, message }
exports.resetHwid = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const { key } = req.body;
  if (!key) { res.json({ success: false, error: 'Key não informada.' }); return; }

  const apiKey = functions.config().luarmor?.api_key;
  try {
    const r = await fetch(
      `https://api.luarmor.net/v3/projects/${LUARMOR_PROJECT_ID}/users/resethwid`,
      {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_key: key })
      }
    );
    const data = await r.json();
    if (data.success) {
      await db.collection('keys').doc(key).set(
        { hwid: null, status: 'reset', updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
    res.json(data);
  } catch(e) {
    res.status(500).json({ success: false, error: 'Erro interno.' });
  }
});

// ── generateKey ──────────────────────────────────────────────
// POST { plan, days, email, note }  →  { success, key }
exports.generateKey = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const adminToken = req.headers['x-admin-token'];
  const saved      = functions.config().admin?.token || 'midnighthub-admin-2026';
  if (adminToken !== saved) { res.status(401).json({ success: false, error: 'Não autorizado.' }); return; }

  const { plan, days, email, note } = req.body;
  const apiKey = functions.config().luarmor?.api_key;

  try {
    const body = { note: note || `${plan} | ${email || 'manual'}` };
    if (days > 0) body.key_days = parseInt(days);

    const r = await fetch(
      `https://api.luarmor.net/v3/projects/${LUARMOR_PROJECT_ID}/users`,
      {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );
    const data = await r.json();

    if (!data.success || !data.user_key) {
      res.json({ success: false, error: data.message || 'Erro ao gerar key.' }); return;
    }

    const keyData = {
      key: data.user_key, luarmor_key: data.user_key,
      plan: parseInt(days) < 0 ? 'Permanente' : `${days} Dias`,
      days: parseInt(days) || -1, email: email || '', note: note || '',
      status: 'active',
      expires_at: parseInt(days) > 0 ? Math.floor(Date.now()/1000) + 86400*parseInt(days) : -1,
      source: 'manual', total_executions: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('keys').doc(data.user_key).set(keyData);
    res.json({ success: true, key: data.user_key, data: keyData });

  } catch(e) {
    res.status(500).json({ success: false, error: 'Erro interno.' });
  }
});

// ── mpWebhook ────────────────────────────────────────────────
// Recebe notificação do Mercado Pago, gera key e salva no Firebase
exports.mpWebhook = functions.https.onRequest(async (req, res) => {
  res.status(200).send('OK'); // Sempre 200 pra MP não retentar

  try {
    const { type, data } = req.body;
    if (type !== 'payment') return;

    const mpToken   = functions.config().mp?.token || '';
    const paymentId = data?.id;
    if (!paymentId || !mpToken) return;

    // Detalhes do pagamento
    const mpRes  = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${mpToken}` } });
    const payment = await mpRes.json();
    if (payment.status !== 'approved') return;

    const email = payment.payer?.email || payment.metadata?.email || '';
    const days  = parseInt(payment.metadata?.days || '30');
    const plan  = payment.metadata?.plan || `${days} Dias`;
    const apiKey = functions.config().luarmor?.api_key;

    // Gera key no Luarmor
    const body = { note: `Compra MP | ${email}` };
    if (days > 0) body.key_days = days;

    const lr    = await fetch(`https://api.luarmor.net/v3/projects/${LUARMOR_PROJECT_ID}/users`,
      { method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const lData = await lr.json();
    if (!lData.success || !lData.user_key) return;

    const generatedKey = lData.user_key;

    await db.collection('keys').doc(generatedKey).set({
      key: generatedKey, luarmor_key: generatedKey,
      plan, days, email, status: 'active',
      expires_at: days > 0 ? Math.floor(Date.now()/1000) + 86400*days : -1,
      source: 'purchase', mp_payment_id: paymentId,
      total_executions: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await db.collection('orders').add({
      email, plan, days,
      price: payment.transaction_amount,
      key: generatedKey, mp_payment_id: paymentId,
      status: 'approved',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // TODO: enviar email → instale nodemailer ou use SendGrid
    // await sendKeyEmail(email, generatedKey, plan);

    console.log(`✅ Key gerada para ${email}: ${generatedKey}`);

  } catch(e) {
    console.error('Erro mpWebhook:', e);
  }
});
