const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

/* =====================================================================
   GOOJOB / SwipeJob backend — Mobile Money subscriptions via pawaPay.

   Before this existed the subscription step was SIMULATED (a 2.6s timer),
   so nobody was ever actually charged. Now Zambian members get a real MoMo
   PIN prompt and the money is collected.

   Environment variables (Vercel -> Project Settings -> Environment Variables):
     PAWAPAY_TOKEN  - pawaPay API token. Absent => simulated mode, and the site
                      keeps its old behaviour (lead to the inbox, no charge).
     PAWAPAY_ENV    - 'sandbox' (default) or 'production'.
     SUB_SECRET     - signs subscription receipts (HMAC). Set a long random
                      value in production so a receipt cannot be forged.

   NOTE ON NIGERIA: the site also offers a Nigeria plan (OPay / PalmPay /
   Paga / MTN NG). Those are NOT wired to pawaPay here — only Zambia is
   verified. Nigerian sign-ups keep the manual/lead flow until a Nigerian
   provider is confirmed, rather than pretending to charge them.
   ===================================================================== */
const PAWAPAY_TOKEN = process.env.PAWAPAY_TOKEN;
const PAWAPAY_BASE = process.env.PAWAPAY_ENV === 'production'
    ? 'https://api.pawapay.io'
    : 'https://api.sandbox.pawapay.io';
const SUB_SECRET = process.env.SUB_SECRET || crypto.randomBytes(32).toString('hex');
const SECRET_IS_EPHEMERAL = !process.env.SUB_SECRET;

const { randomUUID } = crypto;

// Only Zambian mobile money is wired up. Nigerian ids deliberately return null.
const PAWAPAY_PROVIDERS = {
    mtn: 'MTN_MOMO_ZMB',
    airtel: 'AIRTEL_OAPI_ZMB',
    zamtel: 'ZAMTEL_ZMB'
};
const providerCode = id => PAWAPAY_PROVIDERS[String(id || '').toLowerCase()] || null;

// Members type numbers as "097 123 4567", "0971234567" or "+260971234567".
function normalizePhone(input) {
    let d = String(input || '').replace(/\D/g, '');
    if (d.startsWith('260')) d = d.slice(3);
    if (d.startsWith('0')) d = d.slice(1);
    return /^(9|7)\d{8}$/.test(d) ? d : null;
}

const sign = id => crypto.createHmac('sha256', SUB_SECRET).update(String(id)).digest('base64url').slice(0, 24);

const pawapayHeaders = () => ({
    Authorization: `Bearer ${PAWAPAY_TOKEN}`,
    'Content-Type': 'application/json'
});

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        service: 'goojob-backend',
        paymentsConfigured: Boolean(PAWAPAY_TOKEN),
        paymentsEnv: process.env.PAWAPAY_ENV === 'production' ? 'production' : 'sandbox',
        subSecretConfigured: !SECRET_IS_EPHEMERAL,
        countriesLive: ['zambia']
    });
});

// Starts the subscription charge; the member approves with their MoMo PIN.
app.post('/api/pay', async (req, res) => {
    if (!PAWAPAY_TOKEN) return res.json({ simulated: true });

    const { phone, provider, amount, country, depositId: wanted } = req.body || {};
    if (country && String(country).toLowerCase() !== 'zambia') {
        return res.json({ unsupportedCountry: true });
    }
    const code = providerCode(provider);
    const msisdn = normalizePhone(phone);
    if (!msisdn || !(amount > 0) || !code) {
        return res.status(400).json({ error: 'INVALID_INPUT' });
    }

    const depositId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(wanted || ''))
        ? String(wanted)
        : randomUUID();

    try {
        const r = await axios.post(`${PAWAPAY_BASE}/v2/deposits`, {
            depositId,
            amount: String(Math.round(amount * 100) / 100),
            currency: 'ZMW',
            payer: { type: 'MMO', accountDetails: { phoneNumber: '260' + msisdn, provider: code } },
            customerMessage: 'GOOJOB membership'
        }, { headers: pawapayHeaders(), timeout: 25000 });

        res.json({ tx_ref: depositId, status: r.data && r.data.status });
    } catch (error) {
        res.status(502).json({
            error: 'PAYMENT_ERROR',
            message: error.message,
            response: error.response ? error.response.data : null
        });
    }
});

async function fetchDepositStatus(txRef) {
    const r = await axios.get(`${PAWAPAY_BASE}/v2/deposits/${encodeURIComponent(txRef)}`, {
        headers: pawapayHeaders(), timeout: 20000
    });
    const d = r.data && (r.data.data || (Array.isArray(r.data) ? r.data[0] : r.data));
    const s = String((d && d.status) || 'pending').toUpperCase();
    return s === 'COMPLETED' ? 'successful'
        : (s === 'FAILED' || s === 'REJECTED' || s === 'CANCELLED') ? 'failed'
        : 'pending';
}

app.get('/api/pay/status', async (req, res) => {
    if (!PAWAPAY_TOKEN) return res.json({ simulated: true, status: 'successful' });
    try {
        res.json({ status: await fetchDepositStatus(req.query.tx_ref || '') });
    } catch (error) {
        res.json({ status: 'pending' }); // a fresh deposit can 404 briefly
    }
});

// pawaPay requires a callback URL before it will issue an API token.
app.post('/api/pay/callback', (req, res) => {
    console.log('pawaPay callback:', JSON.stringify(req.body || {}).slice(0, 500));
    res.status(200).json({ received: true });
});
app.get('/api/pay/callback', (req, res) => res.status(200).json({ ok: true }));

// Issues a signed membership receipt — only after the server itself confirms
// the money arrived, so the browser cannot mint a membership on its own.
app.post('/api/activate-membership', async (req, res) => {
    const { tx_ref } = req.body || {};
    if (PAWAPAY_TOKEN) {
        if (!tx_ref) return res.status(400).json({ error: 'MISSING_TX_REF' });
        try {
            const status = await fetchDepositStatus(tx_ref);
            if (status !== 'successful') return res.status(402).json({ error: 'PAYMENT_NOT_CONFIRMED', status });
        } catch (e) {
            return res.status(502).json({ error: 'STATUS_CHECK_FAILED', message: e.message });
        }
    }
    const membershipId = tx_ref || randomUUID();
    res.json({ active: true, membershipId, token: sign(membershipId) });
});

// Lets the site (or an operator) re-check a membership receipt.
app.post('/api/verify-membership', (req, res) => {
    const { membershipId, token } = req.body || {};
    if (!membershipId || !token) return res.json({ valid: false });
    const expected = sign(membershipId);
    const a = Buffer.from(String(token)), b = Buffer.from(expected);
    res.json({ valid: a.length === b.length && crypto.timingSafeEqual(a, b) });
});

module.exports = app;
