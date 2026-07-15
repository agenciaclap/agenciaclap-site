/**
 * instagram-integration.js — Agência CLAP
 * ============================================================================
 * Módulo com responsabilidade única: a experiência de busca e seleção de
 * perfil do Instagram dentro do checkout (etapa "Perfil").
 *
 * O QUE ESTE ARQUIVO NÃO SABE, DE PROPÓSITO:
 * - Não sabe que existe HikerAPI, nem qualquer outro fornecedor de dados.
 * - Não conhece tokens, chaves de API nem nomes de campo de fornecedor externo.
 * - Não sabe que existe Mercado Pago, checkout, admin ou qualquer outra
 *   parte do sistema.
 *
 * Ele só conhece UM contrato, com a própria API da Agência CLAP:
 *
 *   POST /api/instagram/search   body: { username }
 *   -> { success: true,  profile: { username, fullName, avatar, followers, following, posts, verified } }
 *   -> { success: false, error: "not_found" | "invalid_username" | "upstream_error" | ... }
 *
 * Se no futuro o fornecedor de dados por trás dessa API mudar (troca de
 * HikerAPI por outro), este arquivo não precisa de NENHUMA alteração — só
 * o server.js muda.
 *
 * USO (feito pelo index.html):
 *
 *   InstagramIntegration.init({
 *     onSelect: (profile) => { ... } // chamado quando um perfil é confirmado
 *   });
 *   InstagramIntegration.reset(); // ao abrir um novo checkout
 * ============================================================================
 */
(function (global) {
  'use strict';

  const DEFAULT_SEARCH_ENDPOINT = '/api/instagram/search';
  const DEBOUNCE_MS = 350;
  const MIN_LENGTH = 2;

  let searchEndpoint = DEFAULT_SEARCH_ENDPOINT;
  let onSelectCallback = null;
  let els = {};
  let debounceTimer = null;
  let requestId = 0;
  let selectedProfile = null;

  /* ---------- helpers internos (sem depender de nada externo) ---------- */

  function formatCompactNumber(value) {
    if (value == null) return '0';
    if (value >= 1000000) return (value / 1000000).toFixed(1).replace('.0', '') + 'M';
    if (value >= 1000) return (value / 1000).toFixed(1).replace('.0', '') + 'K';
    return String(value);
  }

  function normalizeUsername(raw) {
    let v = (raw || '').trim();
    if (!v) return '';
    const urlMatch = v.match(/instagram\.com\/([^/?#]+)/i);
    if (urlMatch) { v = urlMatch[1]; }
    v = v.replace(/^@/, '').replace(/\/+$/, '');
    return v.toLowerCase();
  }

  function avatarPlaceholder(seed) {
    // Usado só quando não há avatar real (ex: perfil informado manualmente,
    // sem confirmação da busca). Gera um avatar ilustrativo com iniciais —
    // não é uma foto real do perfil.
    return `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(seed)}&backgroundType=gradientLinear`;
  }

  /* ---------- única chamada de rede deste módulo — sempre à API própria ---------- */
  async function searchProfile(username) {
    const res = await fetch(searchEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    return res.json().catch(() => ({ success: false, error: 'unavailable' }));
  }

  /* ---------- UI ---------- */
  function showStatus(html) {
    if (!els.status) return;
    els.status.innerHTML = html;
    els.status.style.display = 'flex';
  }
  function hideStatus() {
    if (!els.status) return;
    els.status.style.display = 'none';
  }

  function renderPreview(profile) {
    selectedProfile = profile;
    if (els.emptyState) els.emptyState.innerHTML = '';
    hideStatus();

    const photo = profile.avatar || avatarPlaceholder(profile.username);
    const hasStats = profile.followers != null;

    if (els.preview) {
      els.preview.innerHTML = `
        <div class="ig-profile-card">
          <img src="${photo}" alt="">
          <div>
            <div class="name">${profile.fullName || '@' + profile.username}</div>
            <div class="user">@${profile.username}</div>
            ${profile.verified
              ? `<span class="ig-verified-tag">✓ Verificado via Instagram</span>`
              : `<span class="ig-verified-tag" style="color:var(--text-soft);">@ informado manualmente — não verificado</span>`}
            ${hasStats ? `
            <div class="ig-stats" style="margin-top:8px;">
              <div><b>${formatCompactNumber(profile.followers)}</b>Seguidores</div>
              <div><b>${formatCompactNumber(profile.following ?? 0)}</b>Seguindo</div>
              <div><b>${formatCompactNumber(profile.posts ?? 0)}</b>Publicações</div>
            </div>` : ''}
          </div>
        </div>
      `;
    }

    if (els.continueBtn) els.continueBtn.disabled = false;
    if (typeof onSelectCallback === 'function') onSelectCallback(profile);
  }

  function renderNotFound(username, isError) {
    if (!els.emptyState) return;
    els.emptyState.innerHTML = `
      <div class="ig-empty-state">
        ${isError
          ? 'Não conseguimos verificar esse perfil agora (falha na consulta).'
          : 'Não encontramos esse perfil no Instagram — confira se o @ está certo.'}
        <br>
        <button id="igUseAnywayBtn">Usar @${username} mesmo assim</button>
      </div>
    `;
    const btn = document.getElementById('igUseAnywayBtn');
    if (btn) {
      btn.addEventListener('click', () => {
        els.emptyState.innerHTML = '';
        renderPreview({
          username, fullName: null, avatar: null,
          followers: null, following: null, posts: null,
          verified: false
        });
      });
    }
  }

  function handleInput() {
    clearTimeout(debounceTimer);
    selectedProfile = null;
    if (els.preview) els.preview.innerHTML = '';
    if (els.emptyState) els.emptyState.innerHTML = '';
    if (els.continueBtn) els.continueBtn.disabled = true;
    hideStatus();

    const normalized = normalizeUsername(els.input.value);
    if (normalized.length < MIN_LENGTH) return;

    debounceTimer = setTimeout(async () => {
      const myRequestId = ++requestId;
      showStatus('<span class="spinner"></span> Verificando perfil...');

      try {
        const result = await searchProfile(normalized);
        if (myRequestId !== requestId) return; // resposta obsoleta, ignora

        hideStatus();

        if (result && result.success && result.profile) {
          renderPreview({ ...result.profile, verified: true });
        } else {
          // O backend só devolve dois motivos possíveis: "not_found" (fato de
          // negócio) ou "unavailable" (qualquer problema técnico, qualquer
          // que seja o fornecedor por trás). Este módulo não precisa saber
          // mais que isso.
          const isRealError = result && result.error === 'unavailable';
          renderNotFound(normalized, !!isRealError);
        }
      } catch (err) {
        if (myRequestId !== requestId) return;
        hideStatus();
        console.error('[InstagramIntegration] erro ao consultar perfil:', err);
        renderNotFound(normalized, true);
      }
    }, DEBOUNCE_MS);
  }

  /* ---------- API pública do módulo ---------- */
  function init(options) {
    options = options || {};
    searchEndpoint = options.searchEndpoint || DEFAULT_SEARCH_ENDPOINT;
    onSelectCallback = options.onSelect || null;

    els = {
      input: document.querySelector(options.inputSelector || '#igSearchInput'),
      status: document.querySelector(options.statusSelector || '#igVerifyStatus'),
      emptyState: document.querySelector(options.emptyStateSelector || '#igEmptyState'),
      preview: document.querySelector(options.previewSelector || '#igProfileCard'),
      continueBtn: document.querySelector(options.continueButtonSelector || '#igContinueBtn')
    };

    if (!els.input) {
      console.warn('[InstagramIntegration] input de busca não encontrado — módulo não inicializado.');
      return;
    }
    els.input.addEventListener('input', handleInput);
  }

  function reset() {
    if (els.input) els.input.value = '';
    if (els.emptyState) els.emptyState.innerHTML = '';
    if (els.preview) els.preview.innerHTML = '';
    if (els.continueBtn) els.continueBtn.disabled = true;
    hideStatus();
    selectedProfile = null;
    requestId++; // invalida qualquer busca pendente em andamento
    clearTimeout(debounceTimer);
  }

  function getSelectedProfile() {
    return selectedProfile;
  }

  global.InstagramIntegration = { init, reset, getSelectedProfile };
})(window);
