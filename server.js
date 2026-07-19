/**
 * server.js — Agência CLAP (backend único da V1)
 * ============================================================================
 * Único arquivo de servidor do projeto. Roda com: node server.js
 * Serve o próprio index.html (em "/" e em "/admin") e expõe as 4 rotas
 * que precisam ficar protegidas do lado do servidor:
 *
 *   GET  /api/instagram/lookup?username=x        → busca real via HikerAPI
 *   POST /api/mercadopago/create-payment          → cria o Payment PIX
 *   POST /api/mercadopago/webhook                  → confirma pagamento
 *   GET  /api/admin/orders                         → dashboard + lista
 *   POST /api/admin/orders/:paymentId/status       → muda status do pedido
 *
 * Por que isso precisa existir (e não dá pra fazer só com o index.html):
 * 1. O Access Token de produção do Mercado Pago não pode ir ao navegador —
 *    quem tiver o token pode criar cobranças, estornar pagamentos e ler
 *    todos os dados de transação da conta real.
 * 2. O webhook do Mercado Pago é uma chamada servidor-a-servidor — só
 *    existe se houver algo rodando pra receber essa chamada.
 * 3. O painel admin precisa enxergar pedidos de TODOS os clientes — isso
 *    exige um armazenamento compartilhado, não algo local do navegador.
 *
 * VARIÁVEIS DE AMBIENTE:
 *   MP_ACCESS_TOKEN    (obrigatória)  — Access Token de produção do Mercado Pago
 *   MP_WEBHOOK_SECRET  (obrigatória)  — gerado ao cadastrar a URL do webhook no painel do MP
 *   HIKER_API_KEY      (opcional)     — se omitida, usa a chave informada nesta V1 (linha abaixo)
 *   ADMIN_PANEL_KEY    (opcional)     — se omitida, usa "TV2026" (mesma senha do login da V1)
 *   PORT               (opcional)     — porta HTTP, padrão 3000
 *
 * DEPENDÊNCIAS: npm install express mercadopago
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const nodemailer = require('nodemailer');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
app.use(express.json());

// NOVO ▸ libera a API pra ser chamada do domínio da TV Sul Capixaba também
// (a CLAP não precisa disso porque o front dela é servido por este mesmo
// servidor — same-origin não passa por CORS).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ----------------------------------------------------------------------------
// Configuração / credenciais
// ----------------------------------------------------------------------------
// Chave informada pelo cliente para esta V1. Como ela já apareceu numa
// captura de tela, recomendo gerar uma nova em hikerapi.com/tokens assim
// que possível e apontar via variável de ambiente HIKER_API_KEY — não
// precisa mexer no código pra trocar.
const HIKER_API_KEY = process.env.HIKER_API_KEY || '8y0kak90tgugvs7zc86pflc584kx6p5i';
const HIKER_API_BASE = 'https://api.hikerapi.com';

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_PUBLIC_KEY = process.env.MP_PUBLIC_KEY || '';
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET;
const ADMIN_PANEL_KEY = process.env.ADMIN_PANEL_KEY || 'TV2026';

// TODO TEMPORÁRIO — diagnóstico da causa do "Public Key não configurada".
// Aparece só nos Logs do Render, nunca na resposta ao cliente. Remover depois de confirmado.
console.log('[DIAGNÓSTICO MP_PUBLIC_KEY]', {
  presente: process.env.MP_PUBLIC_KEY !== undefined,
  tamanho: (process.env.MP_PUBLIC_KEY || '').length,
  temEspacoEmBranco: (process.env.MP_PUBLIC_KEY || '') !== (process.env.MP_PUBLIC_KEY || '').trim(),
  prefixo: (process.env.MP_PUBLIC_KEY || '').slice(0, 8),
  ultimos4: (process.env.MP_PUBLIC_KEY || '').slice(-4)
});
const PORT = process.env.PORT || 3000;

// ----------------------------------------------------------------------------
// E-mail (Rastrear Pedido) — envia via SMTP, sem banco de dados.
// Configure com as credenciais de um e-mail que possa enviar por SMTP.
// Exemplo usando Gmail: SMTP_HOST=smtp.gmail.com, SMTP_PORT=465, SMTP_USER=
// seu e-mail, SMTP_PASS=uma "Senha de app" gerada em myaccount.google.com/
// apppasswords (a senha normal da conta Google não funciona aqui).
// ----------------------------------------------------------------------------
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const TRACK_ORDER_TO = process.env.TRACK_ORDER_TO || 'agenciaclap25@gmail.com';

const mailTransporter = (SMTP_HOST && SMTP_USER && SMTP_PASS)
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    })
  : null;

const mpClient = MP_ACCESS_TOKEN ? new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN, options: { timeout: 8000 } }) : null;
const paymentClient = mpClient ? new Payment(mpClient) : null;

// ----------------------------------------------------------------------------
// Armazenamento de pedidos — arquivo JSON local.
// Serve bem para um servidor Node tradicional sempre ligado (VPS, Docker,
// Railway, Render, etc.). Em serverless (Vercel/Netlify Functions) isso NÃO
// é confiável — cada invocação pode rodar isolada e o arquivo pode não
// estar lá quando o webhook chegar. Nesse caso, troque as 4 funções abaixo
// por um banco de dados de verdade, mantendo a mesma assinatura.
// ----------------------------------------------------------------------------
const DB_FILE = path.join(__dirname, '.orders-db.json');

function readOrders() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')); }
  catch { return {}; }
}
function writeOrders(all) {
  fs.writeFileSync(DB_FILE, JSON.stringify(all, null, 2));
}
function saveOrder(order) {
  const all = readOrders();
  all[order.paymentId] = order;
  writeOrders(all);
}
function getOrderByPaymentId(paymentId) {
  return readOrders()[paymentId] || null;
}
function updateOrderStatus(paymentId, status) {
  const all = readOrders();
  if (!all[paymentId]) return null;
  all[paymentId].status = status;
  all[paymentId].updatedAt = new Date().toISOString();
  writeOrders(all);
  return all[paymentId];
}
function listOrders() {
  return Object.values(readOrders()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ============================================================================
// GET /api/instagram/lookup — busca real de perfil via HikerAPI
// ============================================================================
app.get('/api/instagram/lookup', async (req, res) => {
  const username = String(req.query.username || '').trim().toLowerCase().replace(/^@/, '');

  if (!username || !/^[a-z0-9._]{1,30}$/.test(username)) {
    return res.status(400).json({ error: 'username inválido' });
  }
  if (!HIKER_API_KEY) {
    console.error('[instagram-lookup] HIKER_API_KEY não configurada');
    return res.status(500).json({ error: 'integração não configurada no servidor' });
  }

  try {
    const url = `${HIKER_API_BASE}/v1/user/by/username?username=${encodeURIComponent(username)}`;
    const requestHeaders = { 'x-access-key': HIKER_API_KEY, accept: 'application/json' };
    const hikerRes = await fetch(url, { headers: requestHeaders });

    // Lê o corpo como texto primeiro (pode não ser JSON em erros 401/403/429),
    // e tenta parsear como JSON só depois, sem quebrar se não for.
    const rawBody = await hikerRes.text();
    let parsedBody = rawBody;
    try { parsedBody = JSON.parse(rawBody); } catch { /* corpo não é JSON, mantém como texto */ }

    if (!hikerRes.ok) {
      // Sem mais mensagem genérica — devolve exatamente o que a HikerAPI respondeu,
      // seja 401, 403, 404, 429 ou qualquer outro código.
      const hikerMessage = (parsedBody && typeof parsedBody === 'object')
        ? (parsedBody.message || parsedBody.error || parsedBody.detail || JSON.stringify(parsedBody))
        : parsedBody;

      const diagnostic = {
        hikerStatus: hikerRes.status,
        hikerStatusText: hikerRes.statusText,
        hikerBody: parsedBody,
        hikerMessage,
        endpoint: '/v1/user/by/username',
        requestUrl: url,
        requestHeaders: { 'x-access-key': '(omitido)', accept: requestHeaders.accept }
      };

      console.error('[instagram-lookup] HikerAPI respondeu com erro:', JSON.stringify(diagnostic));
      return res.status(hikerRes.status).json(diagnostic);
    }

    const data = parsedBody;

    // Nomes de campo seguem o padrão da API privada do Instagram. Se a
    // HikerAPI mudar o formato de resposta, ajustar o mapeamento aqui.
    // TODO TEMPORÁRIO — inclui `raw` pra inspecionar os nomes de campo reais
    // vindos da HikerAPI. Remover depois de confirmar o mapeamento.
    return res.status(200).json({
      username: data.username || username,
      name: data.full_name || null,
      profilePictureUrl: data.profile_pic_url_hd || data.profile_pic_url || null,
      followers: data.follower_count ?? null,
      following: data.following_count ?? null,
      posts: data.media_count ?? null,
      raw: data
    });
  } catch (err) {
    const diagnostic = {
      exceptionName: err?.name || null,
      exceptionMessage: err?.message || String(err),
      endpoint: '/v1/user/by/username',
      requestUrl: `${HIKER_API_BASE}/v1/user/by/username?username=${encodeURIComponent(username)}`
    };
    console.error('[instagram-lookup] exceção ao consultar HikerAPI:', JSON.stringify(diagnostic));
    return res.status(502).json(diagnostic);
  }
});

// ============================================================================
// POST /api/mercadopago/create-payment — cria o Payment PIX
// ============================================================================
app.post('/api/mercadopago/create-payment', async (req, res) => {
  const {
    formData, external_reference, description,
    instagram, instagramName, instagramPhoto,
    whatsapp, servico, quantidade,
    origin, cidade, plano, codigoAmplificador   // NOVO ▸ TV Sul Capixaba
  } = req.body || {};

  if (!formData || typeof formData !== 'object') {
    return res.status(400).json({ error: 'formData ausente' });
  }

  // Validação SERVER-SIDE: só pix é aceito aqui, ponto. A tela do Brick só
  // mostrar PIX é cosmético — isso aqui é o que de fato impede cartão/boleto.
  if (formData.payment_method_id !== 'pix') {
    console.warn('[create-payment] tentativa de pagamento não-PIX bloqueada:', formData.payment_method_id);
    return res.status(400).json({ error: 'Apenas pagamentos via PIX são aceitos.' });
  }

  if (!paymentClient) {
    console.error('[create-payment] MP_ACCESS_TOKEN não configurado');
    return res.status(500).json({ error: 'integração de pagamento não configurada no servidor' });
  }

  const payerEmail = formData.payer?.email;
  if (!payerEmail) {
    return res.status(400).json({ error: 'e-mail do pagador ausente' });
  }

  try {
    const idempotencyKey = external_reference || `clap-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const payment = await paymentClient.create({
      body: {
        transaction_amount: Number(formData.transaction_amount),
        description: description || 'Agência CLAP',
        payment_method_id: 'pix',
        payer: { email: payerEmail },
        external_reference: external_reference || undefined
      },
      requestOptions: { idempotencyKey }
    });

    saveOrder({
      paymentId: String(payment.id),
      externalReference: external_reference || null,
      origin: origin || 'clap',                      // NOVO ▸ separa CLAP de TV Sul Capixaba
      instagram: instagram || null,
      instagramName: instagramName || null,
      instagramPhoto: instagramPhoto || null,
      email: payerEmail,
      whatsapp: whatsapp || null,
      servico: servico || null,
      quantidade: quantidade || null,
      cidade: cidade || null,                         // NOVO ▸ TV Sul Capixaba
      plano: plano || null,                           // NOVO ▸ TV Sul Capixaba
      codigoAmplificador: codigoAmplificador || null,  // NOVO ▸ TV Sul Capixaba
      description: description || null,
      valor: Number(formData.transaction_amount),
      status: 'Aguardando pagamento',
      createdAt: new Date().toISOString()
    });

    return res.status(200).json({ id: payment.id, status: payment.status });
  } catch (err) {
    console.error('[create-payment] erro ao criar pagamento:', err);
    return res.status(502).json({ error: 'Falha ao criar o pagamento no Mercado Pago.' });
  }
});

// ============================================================================
// POST /api/mercadopago/webhook — confirma o pagamento (fonte da verdade)
// ============================================================================
// Cadastrar esta URL em: Suas integrações > [seu app] > Webhooks, no painel
// do Mercado Pago. O "Secret Signature" mostrado ali é o MP_WEBHOOK_SECRET —
// não é o Access Token, são coisas diferentes.
function isValidMpSignature({ signatureHeader, requestId, dataId }) {
  if (!signatureHeader || !requestId || !dataId || !MP_WEBHOOK_SECRET) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map(p => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    })
  );
  const { ts, v1: receivedHash } = parts;
  if (!ts || !receivedHash) return false;

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const expectedHash = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(receivedHash));
  } catch {
    return false; // tamanhos diferentes de buffer também caem aqui — assinatura inválida
  }
}

// Ponto único de integração futura com o painel SMM. Por pedido explícito,
// NÃO automatizamos esse envio nesta versão — só logamos.
async function dispatchToSmmPanel(order) {
  console.log('[webhook] pedido pago — envio ao painel SMM continua manual nesta versão:', order.paymentId);
}

app.post('/api/mercadopago/webhook', async (req, res) => {
  if (!MP_WEBHOOK_SECRET || !MP_ACCESS_TOKEN) {
    console.error('[webhook] variáveis de ambiente não configuradas');
    return res.status(500).send('webhook não configurado');
  }

  const dataId = req.query['data.id'] || req.body?.data?.id;
  const type = req.query.type || req.body?.type;

  const valid = isValidMpSignature({
    signatureHeader: req.headers['x-signature'],
    requestId: req.headers['x-request-id'],
    dataId: dataId ? String(dataId).toLowerCase() : null
  });

  if (!valid) {
    console.warn('[webhook] assinatura inválida — notificação rejeitada');
    return res.status(401).send('invalid signature');
  }

  // Responde rápido; o Mercado Pago reenvia por horas/dias se não receber 200.
  res.status(200).send('ok');

  if (type !== 'payment') return;

  try {
    const payment = await paymentClient.get({ id: dataId });
    const paymentId = String(payment.id);
    const order = getOrderByPaymentId(paymentId);
    if (!order) {
      console.warn('[webhook] notificação para pedido desconhecido:', paymentId);
      return;
    }

    if (payment.status === 'approved') {
      const updated = updateOrderStatus(paymentId, 'Pago');
      console.log('[webhook] pedido confirmado como Pago:', paymentId);
      await dispatchToSmmPanel(updated);
    } else if (['rejected', 'cancelled'].includes(payment.status)) {
      updateOrderStatus(paymentId, 'Cancelado');
    }
  } catch (err) {
    console.error('[webhook] erro ao processar notificação:', err);
  }
});

// ============================================================================
// PAINEL ADMINISTRATIVO — /api/admin/orders
// ============================================================================
// A tela de login em index.html#admin é só client-side (usuário/senha
// comparados no navegador) — isso é cosmético e contornável por quem ler o
// código-fonte. Quem de fato protege e-mail/WhatsApp/valores dos clientes
// reais é o header abaixo, validado aqui no servidor.
const ADMIN_STATUSES = ['Aguardando pagamento', 'Pago', 'Em processamento', 'Concluído', 'Cancelado'];

function isAdminAuthorized(req) {
  return req.headers['x-admin-key'] === ADMIN_PANEL_KEY;
}

function computeAdminStats(orders) {
  const now = new Date();
  const todayStr = now.toDateString();
  const monthKey = `${now.getFullYear()}-${now.getMonth()}`;
  const stats = { vendidoHoje: 0, vendidoMes: 0, pagos: 0, emProcessamento: 0, concluidos: 0 };

  for (const o of orders) {
    const createdAt = new Date(o.createdAt);
    const isPaidLike = ['Pago', 'Em processamento', 'Concluído'].includes(o.status);

    if (isPaidLike && createdAt.toDateString() === todayStr) stats.vendidoHoje += Number(o.valor) || 0;
    if (isPaidLike && `${createdAt.getFullYear()}-${createdAt.getMonth()}` === monthKey) stats.vendidoMes += Number(o.valor) || 0;
    if (o.status === 'Pago') stats.pagos += 1;
    if (o.status === 'Em processamento') stats.emProcessamento += 1;
    if (o.status === 'Concluído') stats.concluidos += 1;
  }
  return stats;
}

app.get('/api/admin/orders', (req, res) => {
  if (!isAdminAuthorized(req)) return res.status(401).json({ error: 'não autorizado' });
  let orders = listOrders();
  if (req.query.origin) orders = orders.filter(o => (o.origin || 'clap') === req.query.origin); // NOVO ▸ ?origin=tvsulcapixaba
  return res.status(200).json({ stats: computeAdminStats(orders), orders });
});

app.post('/api/admin/orders/:paymentId/status', (req, res) => {
  if (!isAdminAuthorized(req)) return res.status(401).json({ error: 'não autorizado' });

  const { paymentId } = req.params;
  const { status } = req.body || {};
  if (!ADMIN_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status inválido' });
  }

  const updated = updateOrderStatus(paymentId, status);
  if (!updated) return res.status(404).json({ error: 'pedido não encontrado' });
  return res.status(200).json({ order: updated });
});

// ============================================================================
// POST /api/track-order — "Rastrear Pedido". Só dispara um e-mail, sem banco
// de dados, sem consulta nenhuma. O cliente informa o e-mail e a equipe
// responde manualmente por lá.
// ============================================================================
app.post('/api/track-order', async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  if (!emailOk) {
    return res.status(400).json({ error: 'e-mail inválido' });
  }
  if (!mailTransporter) {
    console.error('[track-order] SMTP não configurado (SMTP_HOST/SMTP_USER/SMTP_PASS)');
    return res.status(500).json({ error: 'envio de e-mail não configurado no servidor' });
  }

  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const corpo = `Nova solicitação de rastreamento.\n\nE-mail informado:\n\n${email}\n\nData e hora:\n\n${agora}`;

  try {
    await mailTransporter.sendMail({
      from: SMTP_FROM,
      to: TRACK_ORDER_TO,
      subject: 'Solicitação de Rastreamento de Pedido',
      text: corpo
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[track-order] erro ao enviar e-mail:', err);
    return res.status(502).json({ error: 'falha ao enviar a solicitação' });
  }
});

// ============================================================================
// SITE ESTÁTICO — serve o próprio index.html em "/" e em "/admin"
// ============================================================================
const INDEX_PATH = path.join(__dirname, 'index.html');

function renderIndexHtml() {
  const raw = fs.readFileSync(INDEX_PATH, 'utf-8');
  return raw.replaceAll('__MP_PUBLIC_KEY__', MP_PUBLIC_KEY);
}

app.get(['/', '/admin'], (req, res) => {
  // Trava explícita contra cache: essa página é gerada dinamicamente (a
  // MP_PUBLIC_KEY é injetada a cada request) e NUNCA pode ser servida de
  // uma cópia antiga por navegador, CDN ou proxy intermediário. Sem isso,
  // uma versão anterior (com o token não substituído) poderia continuar
  // sendo exibida mesmo depois de o servidor já estar corrigido.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  res.type('html').send(renderIndexHtml());
});
// { index: false } impede que este middleware sirva o index.html cru
// automaticamente em "/" — isso garante que a rota acima (que injeta a
// MP_PUBLIC_KEY) é sempre quem responde por essa página, independente da
// ordem em que as linhas apareçam no arquivo.
app.use(express.static(__dirname, { index: false }));

// NOVO ▸ o front-end da TV Sul Capixaba busca a Public Key aqui em vez de
// receber por template — porque agora ele é servido por outro projeto,
// então o truque de substituir __MP_PUBLIC_KEY__ no HTML não se aplica.
app.get('/api/mercadopago/public-key', (req, res) => {
  res.json({ publicKey: MP_PUBLIC_KEY });
});

// NOVO ▸ consulta pública de status — só devolve o status (nada sensível:
// sem e-mail, sem whatsapp, sem valor). É o que o front-end usa pra saber
// quando o PIX foi pago de verdade, em vez de "fingir" com um temporizador.
app.get('/api/mercadopago/payment-status/:paymentId', (req, res) => {
  const order = getOrderByPaymentId(req.params.paymentId);
  if (!order) return res.status(404).json({ error: 'pedido não encontrado' });
  res.json({ status: order.status });
});

app.listen(PORT, () => {
  console.log(`Agência CLAP rodando em http://localhost:${PORT}`);
  if (!MP_ACCESS_TOKEN) console.warn('⚠️  MP_ACCESS_TOKEN não definido — pagamentos vão falhar até configurar.');
  if (!MP_PUBLIC_KEY) console.warn('⚠️  MP_PUBLIC_KEY não definida — o Payment Brick não vai renderizar até configurar.');
  if (!mailTransporter) console.warn('⚠️  SMTP não configurado (SMTP_HOST/SMTP_USER/SMTP_PASS) — Rastrear Pedido não vai enviar e-mail até configurar.');
  if (!MP_WEBHOOK_SECRET) console.warn('⚠️  MP_WEBHOOK_SECRET não definido — webhook vai rejeitar tudo até configurar.');
});
