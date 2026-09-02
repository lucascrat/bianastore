// Efí (formerly Gerencianet) payment integration.
//
// Two separate Efí APIs are involved, with different hosts and different auth:
//   - Pix API (pix.api.efipay.com.br): requires mTLS with the .p12 client
//     certificate on every call, including the OAuth token request itself.
//   - Cobrancas/Charges API (cobrancas.api.efipay.com.br): plain OAuth2
//     client-credentials over HTTPS, no client certificate required — used
//     for the one-step credit card charge.
//
// Card tokenization (turning raw card data into a payment_token) happens
// entirely client-side via Efí's own JS library — this server never sees
// raw card numbers, only the resulting token.
const https = require('https');
const axios = require('axios');

function isConfigured() {
  return Boolean(process.env.EFI_CLIENT_ID && process.env.EFI_CLIENT_SECRET && process.env.EFI_CERT_B64 && process.env.EFI_PIX_KEY);
}

let pixAgent = null;
function getPixAgent() {
  if (!pixAgent) {
    pixAgent = new https.Agent({
      pfx: Buffer.from(process.env.EFI_CERT_B64, 'base64'),
      passphrase: process.env.EFI_CERT_PASSPHRASE || '',
    });
  }
  return pixAgent;
}

const PIX_BASE = process.env.EFI_SANDBOX === 'true' ? 'https://pix-h.api.efipay.com.br' : 'https://pix.api.efipay.com.br';
const CHARGE_BASE = process.env.EFI_SANDBOX === 'true' ? 'https://cobrancas-h.api.efipay.com.br' : 'https://cobrancas.api.efipay.com.br';

let pixToken = null; // { value, expiresAt }
async function getPixAccessToken() {
  if (pixToken && pixToken.expiresAt > Date.now() + 5000) return pixToken.value;
  const basic = Buffer.from(`${process.env.EFI_CLIENT_ID}:${process.env.EFI_CLIENT_SECRET}`).toString('base64');
  const { data } = await axios.post(
    `${PIX_BASE}/oauth/token`,
    { grant_type: 'client_credentials' },
    { httpsAgent: getPixAgent(), headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' } }
  );
  pixToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return pixToken.value;
}

let chargeToken = null;
async function getChargeAccessToken() {
  if (chargeToken && chargeToken.expiresAt > Date.now() + 5000) return chargeToken.value;
  const basic = Buffer.from(`${process.env.EFI_CLIENT_ID}:${process.env.EFI_CLIENT_SECRET}`).toString('base64');
  const { data } = await axios.post(
    `${CHARGE_BASE}/v1/authorize`,
    {},
    { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' } }
  );
  chargeToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return chargeToken.value;
}

// txid must be 26-35 alphanumeric characters. Derive one deterministically
// from the order number so it's stable/idempotent if the request is retried.
function txidFromOrderNumber(orderNumber) {
  const base = 'BSORDER' + orderNumber.replace(/[^A-Za-z0-9]/g, '');
  return base.padEnd(26, '0').slice(0, 35);
}

async function createPixCharge({ orderNumber, valor, solicitacaoPagador }) {
  const token = await getPixAccessToken();
  const txid = txidFromOrderNumber(orderNumber);
  const { data } = await axios.put(
    `${PIX_BASE}/v2/cob/${txid}`,
    {
      calendario: { expiracao: 3600 }, // 1h to pay
      valor: { original: valor.toFixed(2) },
      chave: process.env.EFI_PIX_KEY,
      solicitacaoPagador: solicitacaoPagador.slice(0, 140),
    },
    { httpsAgent: getPixAgent(), headers: { Authorization: `Bearer ${token}` } }
  );
  return { txid, pixCopiaECola: data.pixCopiaECola, status: data.status };
}

async function getPixChargeStatus(txid) {
  const token = await getPixAccessToken();
  const { data } = await axios.get(`${PIX_BASE}/v2/cob/${txid}`, {
    httpsAgent: getPixAgent(),
    headers: { Authorization: `Bearer ${token}` },
  });
  return data.status; // 'ATIVA' | 'CONCLUIDA' | 'REMOVIDA_PELO_USUARIO_RECEBEDOR' | 'REMOVIDA_PELO_PSP'
}

// items: [{name, value (cents), amount}]. credit_card: {customer, installments, payment_token, billing_address}.
async function chargeCard({ items, creditCard }) {
  const token = await getChargeAccessToken();
  const { data } = await axios.post(
    `${CHARGE_BASE}/v1/charge/one-step`,
    { items, payment: { credit_card: creditCard } },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return data; // { code, data: { charge_id, status, total, installments, ... } }
}

module.exports = { isConfigured, createPixCharge, getPixChargeStatus, chargeCard };
