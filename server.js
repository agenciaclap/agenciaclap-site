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
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
app.use(express.json());

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
const PORT = process.env.PORT || 3000;

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
    const hikerRes = await fetch(url, {
      headers: { 'x-access-key': HIKER_API_KEY, accept: 'application/json' }
    });

    if (hikerRes.status === 404) {
      return res.status(404).json({ error: 'perfil não encontrado' });
    }
    if (!hikerRes.ok) {
      console.error('[instagram-lookup] HikerAPI respondeu', hikerRes.status);
      return res.status(502).json({ error: 'falha ao consultar o provedor de dados do Instagram' });
    }

    const data = await hikerRes.json();

    // Nomes de campo seguem o padrão da API privada do Instagram. Se a
    // HikerAPI mudar o formato de resposta, ajustar o mapeamento aqui.
    return res.status(200).json({
      username: data.username || username,
      name: data.full_name || null,
      profilePictureUrl: data.profile_pic_url_hd || data.profile_pic_url || null,
      followers: data.follower_count ?? null,
      following: data.following_count ?? null,
      posts: data.media_count ?? null
    });
  } catch (err) {
    console.error('[instagram-lookup] erro ao consultar HikerAPI:', err);
    return res.status(502).json({ error: 'falha ao consultar o provedor de dados do Instagram' });
  }
});

// ============================================================================
// POST /api/mercadopago/create-payment — cria o Payment PIX
// ============================================================================
app.post('/api/mercadopago/create-payment', async (req, res) => {
  const {
    formData, external_reference, description,
    instagram, instagramName, instagramPhoto,
    whatsapp, servico, quantidade
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
      instagram: instagram || null,
      instagramName: instagramName || null,
      instagramPhoto: instagramPhoto || null,
      email: payerEmail,
      whatsapp: whatsapp || null,
      servico: servico || null,
      quantidade: quantidade || null,
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
  const orders = listOrders();
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
// SITE ESTÁTICO — serve o próprio index.html em "/" e em "/admin"
// ============================================================================
const INDEX_PATH = path.join(__dirname, 'index.html');

function renderIndexHtml() {
  const raw = fs.readFileSync(INDEX_PATH, 'utf-8');
  return raw.replace('__MP_PUBLIC_KEY__', MP_PUBLIC_KEY);
}

app.get(['/', '/admin'], (req, res) => {
  res.type('html').send(renderIndexHtml());
});
// { index: false } impede que este middleware sirva o index.html cru
// automaticamente em "/" — isso garante que a rota acima (que injeta a
// MP_PUBLIC_KEY) é sempre quem responde por essa página, independente da
// ordem em que as linhas apareçam no arquivo.
app.use(express.static(__dirname, { index: false }));

app.listen(PORT, () => {
  console.log(`Agência CLAP rodando em http://localhost:${PORT}`);
  if (!MP_ACCESS_TOKEN) console.warn('⚠️  MP_ACCESS_TOKEN não definido — pagamentos vão falhar até configurar.');
  if (!MP_PUBLIC_KEY) console.warn('⚠️  MP_PUBLIC_KEY não definida — o Payment Brick não vai renderizar até configurar.');
  if (!MP_WEBHOOK_SECRET) console.warn('⚠️  MP_WEBHOOK_SECRET não definido — webhook vai rejeitar tudo até configurar.');
});
