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
// ==========================================
// AUTENTICAÇÃO ADMIN E INTEGRAÇÃO COM API
// ==========================================
const NIMARI_API_BASE =
  typeof window.NIMARI_API_URL === 'string' && window.NIMARI_API_URL
    ? window.NIMARI_API_URL.replace(/\/$/, '')
    : '/api';

let adminSessionToken = sessionStorage.getItem('nimari_admin_token') || '';

function closeAdminLogin() {
  const overlay = document.getElementById('adminLoginOverlay');
  const errEl = document.getElementById('adminLoginErr');
  if (errEl) errEl.style.display = 'none';
  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.remove('active', 'open', 'show');
  }
}

async function adminLogin() {
  const input = document.getElementById('adminPwdInput');
  const errEl = document.getElementById('adminLoginErr');
  const password = input ? String(input.value || '').trim() : '';

  if (errEl) errEl.style.display = 'none';

  if (!password) {
    if (errEl) {
      errEl.textContent = 'Digite a senha de acesso.';
      errEl.style.display = 'block';
    }
    return;
  }

  try {
    const resp = await fetch(`${NIMARI_API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok || !data.token) {
      if (errEl) {
        errEl.textContent = data.error || 'Senha incorreta. Tente novamente.';
        errEl.style.display = 'block';
      }
      return;
    }

    adminSessionToken = data.token;
    sessionStorage.setItem('nimari_admin_token', adminSessionToken);
    if (input) input.value = '';
    closeAdminLogin();

    const adminPanel =
      document.getElementById('adminPanel') ||
      document.getElementById('adminDashboard') ||
      document.querySelector('[data-admin-panel]');
    if (adminPanel) {
      adminPanel.style.display = 'block';
      adminPanel.classList.add('active', 'open', 'show');
    }

    alert('Login administrativo realizado com sucesso.');
  } catch (err) {
    console.error('Erro no login admin:', err);
    if (errEl) {
      errEl.textContent = 'Erro de conexão com o servidor.';
      errEl.style.display = 'block';
    }
  }
}

async function nimariUploadImagem(file, pasta = 'produtos') {
  if (!adminSessionToken) {
    throw new Error('Faça o login administrativo antes de enviar imagens.');
  }
  const formData = new FormData();
  formData.append('file', file);
  formData.append('pasta', pasta);

  const resp = await fetch(`${NIMARI_API_BASE}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminSessionToken}` },
    body: formData,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || 'Falha no upload de imagem.');
  return data.url;
}

async function nimariCriarProduto(payload) {
  if (!adminSessionToken) {
    throw new Error('Faça o login administrativo antes de cadastrar produtos.');
  }
  const resp = await fetch(`${NIMARI_API_BASE}/produtos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminSessionToken}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || 'Falha ao salvar produto.');
  return data;
}

window.adminLogin = adminLogin;
window.closeAdminLogin = closeAdminLogin;
window.nimariUploadImagem = nimariUploadImagem;
window.nimariCriarProduto = nimariCriarProduto;
/* ── LOGIN ADMIN DIRETO + API NIMARI ── */
(function () {
  const API_BASE =
    typeof window.NIMARI_API_URL === 'string' && window.NIMARI_API_URL
      ? window.NIMARI_API_URL.replace(/\/$/, '')
      : '/api';

  function getOverlay() {
    return document.getElementById('adminLoginOverlay');
  }

  function getErrEl() {
    return document.getElementById('adminLoginErr');
  }

  window.openAdminLogin = function () {
    const ov = getOverlay();
    const err = getErrEl();
    if (err) err.style.display = 'none';
    if (ov) {
      ov.style.display = 'flex';
      ov.classList.add('active', 'open', 'show');
    }
  };

  window.closeAdminLogin = function () {
    const ov = getOverlay();
    const err = getErrEl();
    if (err) err.style.display = 'none';
    if (ov) {
      ov.style.display = 'none';
      ov.classList.remove('active', 'open', 'show');
    }
  };

  window.adminLogin = async function () {
    const inp = document.getElementById('adminPwdInput');
    const err = getErrEl();
    const password = inp ? String(inp.value || '').trim() : '';

    if (err) err.style.display = 'none';

    if (!password) {
      if (err) {
        err.textContent = 'Digite a senha de acesso.';
        err.style.display = 'block';
      }
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.token) {
        if (err) {
          err.textContent = data.error || 'Senha incorreta. Tente novamente.';
          err.style.display = 'block';
        }
        return;
      }

      sessionStorage.setItem('nimari_admin_token', data.token);
      if (inp) inp.value = '';
      window.closeAdminLogin();
      alert('Acesso administrativo liberado!');
    } catch (e) {
      if (err) {
        err.textContent = 'API indisponível: verifique se o Node está rodando no Railway.';
        err.style.display = 'block';
      }
    }
  };

  window.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('nimariQuickAdminBtn')) {
      const btn = document.createElement('button');
      btn.id = 'nimariQuickAdminBtn';
      btn.type = 'button';
      btn.textContent = 'Admin';
      btn.style.cssText =
        'position:fixed;bottom:14px;left:14px;z-index:9999;background:#1a1a1a;color:#fff;border:none;border-radius:6px;padding:8px 12px;font-size:12px;cursor:pointer;opacity:0.8;';
      btn.addEventListener('click', window.openAdminLogin);
      document.body.appendChild(btn);
    }
  });
})();
/* ── PAINEL RÁPIDO DE CADASTRO E UPLOAD WEBP (R2 + POSTGRES) ── */
(function () {
  const API_BASE =
    typeof window.NIMARI_API_URL === 'string' && window.NIMARI_API_URL
      ? window.NIMARI_API_URL.replace(/\/$/, '')
      : '/api';

  function getToken() {
    return sessionStorage.getItem('nimari_admin_token') || '';
  }

  window.abrirPainelCadastroNimari = function () {
    if (!getToken()) {
      window.openAdminLogin?.();
      return;
    }

    let box = document.getElementById('nimariQuickProductModal');
    if (!box) {
      box = document.createElement('div');
      box.id = 'nimariQuickProductModal';
      box.style.cssText =
        'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:16px;';

      box.innerHTML = `
        <div style="background:#fff;color:#1a1a1a;width:100%;max-width:460px;border-radius:10px;padding:20px;box-shadow:0 12px 32px rgba(0,0,0,.35);font-family:sans-serif;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
            <strong style="font-size:16px;">Cadastrar Produto · NIMARI</strong>
            <button type="button" id="nimariCloseQuickProd" style="background:none;border:none;font-size:20px;cursor:pointer;">×</button>
          </div>

          <div style="display:flex;flex-direction:column;gap:10px;">
            <input id="qpNome" type="text" placeholder="Nome do produto (ex.: Sabonete Líquido Natura)" style="padding:9px;border:1px solid #ccc;border-radius:6px;" />
            <input id="qpPreco" type="text" placeholder="Preço (ex.: 49.90)" style="padding:9px;border:1px solid #ccc;border-radius:6px;" />
            <select id="qpCategoria" style="padding:9px;border:1px solid #ccc;border-radius:6px;">
              <option value="cosmeticos">Cosméticos</option>
              <option value="moda-intima">Moda Íntima</option>
              <option value="perfumaria">Perfumaria</option>
            </select>
            <input id="qpDescricao" type="text" placeholder="Descrição curta" style="padding:9px;border:1px solid #ccc;border-radius:6px;" />
            <label style="font-size:12px;color:#444;">Imagem (converte para .webp no Cloudflare R2):</label>
            <input id="qpFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif" />
            <div id="qpStatus" style="font-size:12px;color:#555;min-height:18px;word-break:break-all;"></div>

            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px;">
              <button type="button" id="nimariCancelQuickProd" style="padding:9px 14px;border:1px solid #ccc;background:#f5f5f5;border-radius:6px;cursor:pointer;">Fechar</button>
              <button type="button" id="nimariSaveQuickProd" style="padding:9px 16px;border:none;background:#1a1a1a;color:#fff;border-radius:6px;cursor:pointer;">Salvar Produto</button>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(box);

      const fechar = () => {
        box.style.display = 'none';
      };
      box.querySelector('#nimariCloseQuickProd').onclick = fechar;
      box.querySelector('#nimariCancelQuickProd').onclick = fechar;

      box.querySelector('#nimariSaveQuickProd').onclick = async () => {
        const statusEl = box.querySelector('#qpStatus');
        const nome = box.querySelector('#qpNome').value.trim();
        const preco = box.querySelector('#qpPreco').value.trim();
        const categoria = box.querySelector('#qpCategoria').value;
        const descricao = box.querySelector('#qpDescricao').value.trim();
        const file = box.querySelector('#qpFile').files[0];
        const token = getToken();

        if (!nome) {
          statusEl.textContent = 'Informe o nome do produto.';
          return;
        }

        try {
          let imagemUrl = '';
          if (file) {
            statusEl.textContent = 'Enviando imagem e convertendo para .webp no R2...';
            const fd = new FormData();
            fd.append('file', file);
            fd.append('pasta', 'produtos');

            const upRes = await fetch(`${API_BASE}/upload`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
              body: fd,
            });
            const upData = await upRes.json();
            if (!upRes.ok || !upData.url) {
              throw new Error(upData.error || 'Falha no upload para o R2.');
            }
            imagemUrl = upData.url;
            statusEl.textContent = `Imagem WebP salva no R2: ${imagemUrl}`;
          }

          statusEl.textContent = 'Salvando produto no banco de dados...';
          const prodRes = await fetch(`${API_BASE}/produtos`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              nome,
              preco,
              categoria,
              descricao,
              imagem: imagemUrl,
              imagens: imagemUrl ? [imagemUrl] : [],
            }),
          });
          const prodData = await prodRes.json();
          if (!prodRes.ok) {
            throw new Error(prodData.error || 'Falha ao cadastrar produto.');
          }

          statusEl.textContent = `Produto cadastrado com sucesso! ID: ${prodData.id}`;
          if (typeof applySortAndFilter === 'function') {
            if (Array.isArray(window.state?.produtos)) {
              window.state.produtos.unshift(prodData);
            }
            applySortAndFilter();
          }
        } catch (err) {
          statusEl.textContent = `Erro: ${err.message}`;
        }
      };
    }

    box.style.display = 'flex';
  };

  const oldAdminLogin = window.adminLogin;
  window.adminLogin = async function () {
    await oldAdminLogin?.();
    if (getToken()) {
      window.abrirPainelCadastroNimari();
    }
  };

  window.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('nimariNovoProdutoBtn')) {
      const btn = document.createElement('button');
      btn.id = 'nimariNovoProdutoBtn';
      btn.type = 'button';
      btn.textContent = '+ Produto';
      btn.style.cssText =
        'position:fixed;bottom:14px;left:76px;z-index:9999;background:#8b4a62;color:#fff;border:none;border-radius:6px;padding:8px 12px;font-size:12px;cursor:pointer;opacity:0.9;';
      btn.addEventListener('click', window.abrirPainelCadastroNimari);
      document.body.appendChild(btn);
    }
  });
})();