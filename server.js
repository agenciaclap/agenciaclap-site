/**
 * MVP ISOLADO — Agência CLAP
 * ============================================================================
 * Objetivo único: provar, isoladamente, que:
 *   1) a busca de perfil do Instagram (via HikerAPI) funciona neste ambiente;
 *   2) o Mercado Pago (Payment Brick, PIX) gera cobrança neste ambiente.
 *
 * Sem admin, sem catálogo, sem carrinho, sem WhatsApp, sem e-mail, sem etapas.
 * Rotas usadas — exatamente as mesmas do projeto completo, sem nenhuma
 * lógica nova:
 *   GET  /api/instagram/lookup?username=x   → busca real via HikerAPI
 *   POST /api/mercadopago/create-payment    → cria o Payment PIX (R$ 1,00 fixo)
 *   POST /api/mercadopago/webhook           → confirmação de pagamento
 *
 * Variáveis de ambiente necessárias (as mesmas do projeto completo):
 *   HIKER_API_KEY, MP_ACCESS_TOKEN, MP_PUBLIC_KEY, MP_WEBHOOK_SECRET, PORT
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
app.use(express.json());

const HIKER_API_KEY = process.env.HIKER_API_KEY || '';
const HIKER_API_BASE = 'https://api.hikerapi.com';

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_PUBLIC_KEY = process.env.MP_PUBLIC_KEY || '';
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET;
const PORT = process.env.PORT || 3000;

const mpClient = MP_ACCESS_TOKEN ? new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN, options: { timeout: 8000 } }) : null;
const paymentClient = mpClient ? new Payment(mpClient) : null;

// ============================================================================
// GET /api/instagram/lookup — busca real via HikerAPI (mesma lógica do projeto completo)
// ============================================================================
app.get('/api/instagram/lookup', async (req, res) => {
  const username = String(req.query.username || '').trim().toLowerCase().replace(/^@/, '');

  if (!username || !/^[a-z0-9._]{1,30}$/.test(username)) {
    return res.status(400).json({ error: 'username inválido' });
  }
  if (!HIKER_API_KEY) {
    console.error('[instagram-lookup] HIKER_API_KEY não configurada');
    return res.status(500).json({ error: 'HIKER_API_KEY não configurada no servidor' });
  }

  try {
    const url = `${HIKER_API_BASE}/v1/user/by/username?username=${encodeURIComponent(username)}`;
    const hikerRes = await fetch(url, {
      headers: { 'x-access-key': HIKER_API_KEY, accept: 'application/json' }
    });

    const rawBody = await hikerRes.text();
    let parsedBody = rawBody;
    try { parsedBody = JSON.parse(rawBody); } catch { /* corpo não é JSON */ }

    if (hikerRes.status === 404) {
      return res.status(404).json({ error: 'perfil não encontrado' });
    }
    if (!hikerRes.ok) {
      console.error('[instagram-lookup] HikerAPI respondeu com erro:', hikerRes.status, JSON.stringify(parsedBody));
      return res.status(hikerRes.status).json({
        error: 'falha ao consultar o provedor de dados do Instagram',
        hikerStatus: hikerRes.status,
        hikerBody: parsedBody
      });
    }

    const data = parsedBody;
    return res.status(200).json({
      username: data.username || username,
      name: data.full_name || null,
      profilePictureUrl: data.profile_pic_url_hd || data.profile_pic_url || null,
      followers: data.follower_count ?? null,
      following: data.following_count ?? null,
      posts: data.media_count ?? null,
      verified: !!data.is_verified
    });
  } catch (err) {
    console.error('[instagram-lookup] exceção ao consultar HikerAPI:', err?.message || err);
    return res.status(502).json({ error: 'falha ao consultar o provedor de dados do Instagram', exceptionMessage: err?.message || String(err) });
  }
});

// ============================================================================
// POST /api/mercadopago/create-payment — cria o Payment PIX de R$ 1,00 (teste)
// ============================================================================
app.post('/api/mercadopago/create-payment', async (req, res) => {
  if (!paymentClient) {
    console.error('[create-payment] MP_ACCESS_TOKEN não configurado');
    return res.status(500).json({ error: 'MP_ACCESS_TOKEN não configurado no servidor' });
  }

  const email = String(req.body?.email || 'teste@agenciaclap.com.br').trim();

  try {
    const payment = await paymentClient.create({
      body: {
        transaction_amount: 1.00,
        description: 'MVP de teste — Agência CLAP',
        payment_method_id: 'pix',
        payer: {
          email,
          first_name: 'Teste',
          last_name: 'MVP',
          // CPF de teste — o mesmo número usado em 100% dos exemplos oficiais
          // da documentação da Mercado Pago (Node, Java, .NET, Python, Go, curl).
          // Presente em todo exemplo oficial de PIX que existe, sem exceção.
          identification: { type: 'CPF', number: '19119119100' }
        }
      },
      // Obrigatório desde a atualização de segurança do Mercado Pago (nov/2023):
      // sem isso, a API rejeita com "Header X-Idempotency-Key can't be null".
      requestOptions: { idempotencyKey: crypto.randomUUID() }
    });

    const txData = payment.point_of_interaction?.transaction_data;
    return res.status(200).json({
      id: payment.id,
      status: payment.status,
      qr_code_base64: txData?.qr_code_base64 || null,
      qr_code: txData?.qr_code || null
    });
  } catch (err) {
    console.error('[create-payment] erro ao criar pagamento:', err?.message || err);
    return res.status(502).json({ error: 'Falha ao criar o pagamento no Mercado Pago.', exceptionMessage: err?.message || String(err) });
  }
});

// ============================================================================
// GET /api/mercadopago/payment-status/:id — consulta de status (pro polling do
// frontend depois de mostrar o QR Code — fecha o fluxo até "aprovado").
// Documentado oficialmente como GET /v1/payments/{id}.
// ============================================================================
app.get('/api/mercadopago/payment-status/:id', async (req, res) => {
  if (!paymentClient) {
    return res.status(500).json({ error: 'MP_ACCESS_TOKEN não configurado no servidor' });
  }
  try {
    const payment = await paymentClient.get({ id: req.params.id });
    return res.status(200).json({ id: payment.id, status: payment.status });
  } catch (err) {
    console.error('[payment-status] erro ao consultar pagamento:', err?.message || err);
    return res.status(502).json({ error: 'Falha ao consultar o status do pagamento.', exceptionMessage: err?.message || String(err) });
  }
});

// ============================================================================
// POST /api/mercadopago/webhook — confirmação de pagamento (com validação de assinatura)
// ============================================================================
function isValidMpSignature({ signatureHeader, requestId, dataId }) {
  if (!MP_WEBHOOK_SECRET || !signatureHeader) return false;
  const parts = Object.fromEntries(signatureHeader.split(',').map(p => p.trim().split('=')));
  const ts = parts.ts;
  const hash = parts.v1;
  if (!ts || !hash) return false;
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  return expected === hash;
}

app.post('/api/mercadopago/webhook', async (req, res) => {
  try {
    const dataId = req.body?.data?.id || req.query['data.id'];
    const requestId = req.headers['x-request-id'];
    const signatureHeader = req.headers['x-signature'];

    const valid = isValidMpSignature({ signatureHeader, requestId, dataId });
    if (!valid) {
      console.error('[webhook] assinatura inválida');
      return res.status(401).json({ error: 'assinatura inválida' });
    }

    if (paymentClient && dataId) {
      const payment = await paymentClient.get({ id: dataId });
      console.log('[webhook] pagamento', dataId, '->', payment.status);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[webhook] erro:', err?.message || err);
    return res.status(200).json({ received: true }); // MP espera 200 mesmo em erro interno, pra não reenviar em loop
  }
});

// ============================================================================
// SITE ESTÁTICO — serve o index.html com a MP_PUBLIC_KEY injetada
// ============================================================================
const INDEX_PATH = path.join(__dirname, 'index.html');

function renderIndexHtml() {
  const raw = fs.readFileSync(INDEX_PATH, 'utf-8');
  return raw.replaceAll('__MP_PUBLIC_KEY__', MP_PUBLIC_KEY);
}

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.type('html').send(renderIndexHtml());
});
app.use(express.static(__dirname, { index: false }));

app.listen(PORT, () => {
  console.log(`MVP Agência CLAP rodando em http://localhost:${PORT}`);
  if (!HIKER_API_KEY) console.warn('⚠️  HIKER_API_KEY não definida — busca de Instagram não vai funcionar.');
  if (!MP_ACCESS_TOKEN) console.warn('⚠️  MP_ACCESS_TOKEN não definida — criação de pagamento não vai funcionar.');
  if (!MP_PUBLIC_KEY) console.warn('⚠️  MP_PUBLIC_KEY não definida — o Payment Brick não vai renderizar.');
});
