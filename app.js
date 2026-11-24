/* ── CARREGAMENTO INICIAL DE CONFIG E DEPOIMENTOS ── */
async function loadSavedConfig() {
  try {
    const savedCfg = JSON.parse(localStorage.getItem(STORAGE_KEYS.config) || 'null');
    if (savedCfg && typeof savedCfg === 'object') {
      state.config = {
        ...state.config,
        ...savedCfg,
        wppNumber: sanitizeDigits(savedCfg.wppNumber || DEFAULT_WPP) || DEFAULT_WPP
      };
    }

    const savedCart = JSON.parse(localStorage.getItem(STORAGE_KEYS.cart) || '[]');
    if (Array.isArray(savedCart)) {
      state.cart = savedCart;
    }

    const savedDepos = JSON.parse(localStorage.getItem(STORAGE_KEYS.depoimentos) || '[]');
    if (Array.isArray(savedDepos)) {
      state.depoimentos = savedDepos;
    }
  } catch (err) {
    console.warn('Erro ao carregar configurações locais:', err);
  }

  if (API_URL) {
    try {
      const [cfgRes, depoRes] = await Promise.all([
        fetch(`${API_URL}/config`),
        fetch(`${API_URL}/depoimentos`)
      ]);

      if (cfgRes.ok) {
        const remoteCfg = await cfgRes.json();
        if (remoteCfg && typeof remoteCfg === 'object') {
          state.config = {
            ...state.config,
            wppNumber: sanitizeDigits(remoteCfg.wppNumber || state.config.wppNumber || DEFAULT_WPP) || DEFAULT_WPP,
            aboutImage: remoteCfg.aboutImage ?? state.config.aboutImage ?? '',
            hiddenCategories: Array.isArray(remoteCfg.hiddenCategories)
              ? remoteCfg.hiddenCategories
              : state.config.hiddenCategories,
            brands: Array.isArray(remoteCfg.brands)
              ? remoteCfg.brands
              : state.config.brands
          };
        }
      }

      if (depoRes.ok) {
        const remoteDepos = await depoRes.json();
        if (Array.isArray(remoteDepos)) {
          state.depoimentos = remoteDepos;
        }
      }

      saveAllToStorage();
    } catch (err) {
      console.warn('Falha ao buscar config/depoimentos na API, usando dados locais:', err);
    }
  }

  applyWppLinks();
  applyAboutImage();
  renderBrandsCarousel();
  renderCart();
  renderDepoList();
  renderConfigTab();
  applySortAndFilter();
}

/* ── PERSISTÊNCIA DE CONFIGURAÇÕES VIA PUT /api/config ── */
async function syncConfigToBackend() {
  saveAllToStorage();
  if (!API_URL) return true;
  if (!assertAdminSession()) return false;

  try {
    const res = await adminFetch(`${API_URL}/config`, {
      method: 'PUT',
      body: JSON.stringify({
        wppNumber: state.config.wppNumber,
        aboutImage: state.config.aboutImage,
        hiddenCategories: state.config.hiddenCategories,
        brands: state.config.brands
      })
    });

    if (res.ok) {
      const updated = await res.json();
      state.config = {
        ...state.config,
        ...updated,
        wppNumber: sanitizeDigits(updated.wppNumber || state.config.wppNumber || DEFAULT_WPP) || DEFAULT_WPP
      };
      saveAllToStorage();
    }
    return res.ok;
  } catch (err) {
    console.warn('Erro ao salvar configurações na API:', err);
    return false;
  }
}

async function toggleCategoryVisibility(catKey, isVisible) {
  if (!assertAdminSession()) {
    renderConfigTab();
    return;
  }

  if (isVisible) {
    state.config.hiddenCategories = state.config.hiddenCategories.filter((k) => k !== catKey);
  } else if (!state.config.hiddenCategories.includes(catKey)) {
    state.config.hiddenCategories.push(catKey);
  }

  await syncConfigToBackend();
  applySortAndFilter();
  showToast('Visibilidade de categoria atualizada!');
}

async function saveWppConfig() {
  if (!assertAdminSession()) return;

  const inp = document.getElementById('configWppNumber');
  const digits = sanitizeDigits(inp ? inp.value : '');
  if (!digits) {
    showToast('Informe um número de WhatsApp válido.');
    return;
  }

  state.config.wppNumber = digits;
  await syncConfigToBackend();
  applyWppLinks();
  renderConfigTab();
  showToast('Número do WhatsApp atualizado!');
}

async function saveAboutImage() {
  if (!assertAdminSession()) return;

  if (!pendingAboutImage) {
    showToast('Selecione uma imagem primeiro.');
    return;
  }

  state.config.aboutImage = pendingAboutImage;
  await syncConfigToBackend();
  applyAboutImage();
  showToast('Imagem da seção Sobre salva!');
}

function renderBrandsCarousel() {
  const track = document.getElementById('brandsTrack');
  if (!track || !Array.isArray(state.config.brands) || state.config.brands.length === 0) return;

  const items = [...state.config.brands, ...state.config.brands];
  track.innerHTML = items.map((b) => {
    const nome = escapeHtml(b.nome || 'Marca');
    const logoHtml = b.logo
      ? `<img class="brand-logo" src="${escapeAttr(b.logo)}" alt="${nome}" onerror="this.style.display='none'">`
      : '';
    return `
      <div class="brand-item">
        ${logoHtml}
        <span class="brand-name">${nome}</span>
      </div>
    `;
  }).join('');
}

function renderAdminBrandsList() {
  const wrap = document.getElementById('adminMarcasList');
  if (!wrap) return;

  const brands = Array.isArray(state.config.brands) ? state.config.brands : [];
  if (brands.length === 0) {
    wrap.innerHTML = '<p class="admin-list-hint">Nenhuma marca extra cadastrada.</p>';
    return;
  }

  wrap.innerHTML = brands.map((b, idx) => `
    <div class="extra-img-row" style="margin-bottom:6px;">
      ${b.logo ? `<img class="extra-img-thumb" src="${escapeAttr(b.logo)}" alt="${escapeAttr(b.nome)}">` : ''}
      <span class="extra-img-url" style="color:#fff;font-size:.78rem;">${escapeHtml(b.nome)}</span>
      <button type="button" class="extra-img-del" onclick="removerMarca(${idx})" title="Remover marca">×</button>
    </div>
  `).join('');
}

async function adicionarMarca() {
  if (!assertAdminSession()) return;

  const nomeEl = document.getElementById('novaMarcaNome');
  const logoEl = document.getElementById('novaMarcaLogo');
  const nome = (nomeEl ? nomeEl.value : '').trim();
  const logo = (logoEl ? logoEl.value : '').trim();
  if (!nome) return;

  if (!Array.isArray(state.config.brands)) state.config.brands = [];
  state.config.brands.push({ nome, logo });

  if (nomeEl) nomeEl.value = '';
  if (logoEl) logoEl.value = '';

  await syncConfigToBackend();
  renderBrandsCarousel();
  renderAdminBrandsList();
  showToast('Marca adicionada!');
}

async function removerMarca(index) {
  if (!assertAdminSession()) return;
  if (!Array.isArray(state.config.brands) || !state.config.brands[index]) return;

  state.config.brands.splice(index, 1);
  await syncConfigToBackend();
  renderBrandsCarousel();
  renderAdminBrandsList();
  showToast('Marca removida.');
}