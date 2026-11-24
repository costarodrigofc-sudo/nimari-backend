/* ── CONFIGURAÇÃO GLOBAL E ESTADO ── */
const DEFAULT_WPP = '5598985631126';
const API_URL = window.NIMARI_API_URL || ''; // Ex: 'https://seu-backend.com/api'
const STORAGE_KEYS = {
  products: 'nimari_products_v1',
  cart: 'nimari_cart_v1',
  config: 'nimari_config_v1',
  depoimentos: 'nimari_depoimentos_v1',
  token: 'nimari_admin_token'
};

const SUBCATEGORIES_BY_CAT = {
  cosmeticos: [
    { value: 'pele', label: 'Cuidados com a Pele' },
    { value: 'cabelo', label: 'Cuidados com o Cabelo' },
    { value: 'perf-fem', label: 'Perfumaria Feminina' },
    { value: 'perf-masc', label: 'Perfumaria Masculina' },
    { value: 'infantil-cosm', label: 'Cosméticos Infantil' },
    { value: 'outros-cosm', label: 'Outros Cosméticos' }
  ],
  confeccao: [
    { value: 'intima-fem', label: 'Moda Íntima Feminina' },
    { value: 'intima-inf', label: 'Moda Íntima Infantil' },
    { value: 'sutia', label: 'Sutiã' },
    { value: 'calcinha', label: 'Calcinha' },
    { value: 'outros-conf', label: 'Outros Confecção' }
  ],
  kit: [
    { value: 'kit-presente', label: 'Kit Presente' }
  ]
};

const INITIAL_LIMIT = 20;

let state = {
  products: [],
  filteredProducts: [],
  visibleCount: INITIAL_LIMIT,
  activeCat: 'all',
  activeSub: 'all',
  activeLabel: 'Todos os Produtos',
  sortBy: 'relevancia',
  searchQuery: '',
  cart: [],
  depoimentos: [],
  config: {
    wppNumber: DEFAULT_WPP,
    aboutImage: '',
    hiddenCategories: [],
    brands: []
  },
  isAdmin: false,
  loginAttempts: 0,
  lockUntil: 0
};

let editingProductId = null;
let editExtraImgs = [];
let addExtraImgs = [];
let selectedBadgeEdit = 'none';
let selectedBadgeAdd = 'none';
let editingDepoIndex = -1;
let selectedDepoStars = 5;
let pendingDepoAvatar = '';
let pendingAboutImage = '';
let pendingBatchProducts = [];

/* ── HELPERS ── */
function parsePrice(val) {
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (!val) return 0;
  const clean = String(val)
    .replace(/R\$/gi, '')
    .replace(/\s+/g, '')
    .replace(/\.(?=\d{3}(?:,|$))/g, '')
    .replace(',', '.');
  const num = parseFloat(clean);
  return Number.isFinite(num) ? num : 0;
}

function formatBRL(num) {
  return (Number(num) || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

function sanitizeDigits(str) {
  return String(str || '').replace(/\D+/g, '');
}

function normalizeProduct(raw, index = 0) {
  const mainImg = raw.imagem || raw.img || (Array.isArray(raw.imagens) && raw.imagens[0]) ||
    'https://uiickpwlwsayewcukiog.supabase.co/storage/v1/object/public/Produtos/Produtos/Id_Nimari.jpeg';

  const galeria = Array.isArray(raw.imagens)
    ? raw.imagens.filter(Boolean)
    : (Array.isArray(raw.extraImages) ? raw.extraImages.filter(Boolean) : []);

  return {
    id: raw.id ?? `prod-${Date.now()}-${index}`,
    nome: String(raw.nome || raw.name || 'Produto NIMARI').trim(),
    descricao: String(raw.descricao || raw.desc || '').trim(),
    preco: parsePrice(raw.preco ?? raw.price),
    precoAntigo: raw.precoAntigo || raw.preco_antigo || raw.priceOld
      ? parsePrice(raw.precoAntigo || raw.preco_antigo || raw.priceOld)
      : null,
    categoria: raw.categoria || raw.cat || 'cosmeticos',
    subcategoria: raw.subcategoria || raw.sub || 'outros-cosm',
    imagem: mainImg,
    imagens: galeria,
    badge: raw.badge || 'none',
    wpp: sanitizeDigits(raw.wpp || raw.whatsapp || state.config.wppNumber || DEFAULT_WPP),
    mp_link: String(raw.mp_link || raw.mpLink || '').trim(),
    createdAt: raw.createdAt || raw.created_at || Date.now() - index * 1000,
    vendas: Number(raw.vendas || 0)
  };
}

function getAuthHeaders() {
  const token = sessionStorage.getItem(STORAGE_KEYS.token);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

function showToast(msg) {
  const toast = document.getElementById('adminToast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove('show'), 2800);
}

/* ── PERSISTÊNCIA LOCAL E API ── */
function saveAllToStorage() {
  try {
    localStorage.setItem(STORAGE_KEYS.products, JSON.stringify(state.products));
    localStorage.setItem(STORAGE_KEYS.cart, JSON.stringify(state.cart));
    localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(state.config));
    localStorage.setItem(STORAGE_KEYS.depoimentos, JSON.stringify(state.depoimentos));
  } catch (err) {
    console.warn('Falha ao salvar no localStorage:', err);
  }
}

async function loadSavedProducts() {
  let loaded = false;

  if (API_URL) {
    try {
      const res = await fetch(`${API_URL}/produtos`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          state.products = data.map((item, idx) => normalizeProduct(item, idx));
          loaded = true;
        }
      }
    } catch (err) {
      console.warn('API de produtos indisponível, usando localStorage:', err);
    }
  }

  if (!loaded) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.products) || 'null');
      if (Array.isArray(saved)) {
        state.products = saved.map((item, idx) => normalizeProduct(item, idx));
      }
    } catch (err) {
      console.warn('Erro ao ler produtos do localStorage:', err);
    }
  }

  saveAllToStorage();
  updateSubcategoryCounts();
  applySortAndFilter();
}

function loadSavedConfig() {
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
    console.warn('Erro ao carregar configurações:', err);
  }

  applyWppLinks();
  applyAboutImage();
  renderCart();
  renderDepoList();
  renderConfigTab();
}

/* ── CONTADORES DE SUBCATEGORIAS ── */
function updateSubcategoryCounts() {
  const counts = {};
  state.products.forEach((prod) => {
    if (prod.subcategoria) {
      counts[prod.subcategoria] = (counts[prod.subcategoria] || 0) + 1;
    }
  });

  document.querySelectorAll('.sidebar-sub-item[data-sub]').forEach((el) => {
    const sub = el.getAttribute('data-sub');
    const countEl = el.querySelector('.sub-count');
    if (countEl) {
      countEl.textContent = counts[sub] || 0;
    }
  });
}

/* ── FILTRO, BUSCA E ORDENAÇÃO ── */
function setFilter(cat, sub, label) {
  state.activeCat = cat;
  state.activeSub = sub;
  state.activeLabel = label || 'Todos os Produtos';
  state.visibleCount = INITIAL_LIMIT;

  const btnAll = document.getElementById('btnAll');
  if (btnAll) {
    btnAll.classList.toggle('active', cat === 'all' && sub === 'all');
  }

  document.querySelectorAll('.sidebar-sub-item').forEach((item) => {
    const itemCat = item.getAttribute('data-filter');
    const itemSub = item.getAttribute('data-sub');
    const isMatch = cat !== 'all' && itemCat === cat && (sub === 'all' || itemSub === sub);
    item.classList.toggle('active', isMatch);
  });

  const bcCat = document.getElementById('breadcrumb-cat');
  if (bcCat) bcCat.textContent = state.activeLabel;

  applySortAndFilter();
}

function toggleGroup(groupKey) {
  const btn = document.getElementById(`grp-${groupKey}`);
  const sub = document.getElementById(`sub-${groupKey}`);
  if (btn) btn.classList.toggle('open');
  if (sub) sub.classList.toggle('open');
}

function filterProducts() {
  const input = document.getElementById('catalogSearch');
  state.searchQuery = (input ? input.value : '').trim().toLowerCase();
  state.visibleCount = INITIAL_LIMIT;
  applySortAndFilter();
}

function applySortAndFilter() {
  const sortEl = document.getElementById('sortSelect');
  if (sortEl) state.sortBy = sortEl.value;

  let list = state.products.filter((p) => {
    if (state.config.hiddenCategories.includes(p.categoria)) return false;
    if (state.activeCat !== 'all' && p.categoria !== state.activeCat) return false;
    if (state.activeSub !== 'all' && p.subcategoria !== state.activeSub) return false;

    if (state.searchQuery) {
      const hay = `${p.nome} ${p.descricao} ${p.categoria} ${p.subcategoria}`.toLowerCase();
      if (!hay.includes(state.searchQuery)) return false;
    }
    return true;
  });

  switch (state.sortBy) {
    case 'novo':
      list = list.filter((p) => p.badge === 'novo');
      break;
    case 'oferta':
      list = list.filter((p) => p.badge === 'oferta' || (p.precoAntigo && p.precoAntigo > p.preco));
      break;
    case 'vendido':
      list = [...list].sort((a, b) => (b.vendas || 0) - (a.vendas || 0) || (b.badge === 'vendido' ? 1 : -1));
      break;
    case 'esgotado':
      list = list.filter((p) => p.badge === 'esgotado');
      break;
    case 'preco_menor':
      list = [...list].sort((a, b) => a.preco - b.preco);
      break;
    case 'preco_maior':
      list = [...list].sort((a, b) => b.preco - a.preco);
      break;
    case 'desconto':
      list = [...list].sort((a, b) => {
        const descA = a.precoAntigo && a.precoAntigo > a.preco ? (a.precoAntigo - a.preco) / a.precoAntigo : 0;
        const descB = b.precoAntigo && b.precoAntigo > b.preco ? (b.precoAntigo - b.preco) / b.precoAntigo : 0;
        return descB - descA;
      });
      break;
    case 'mais_recentes':
      list = [...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      break;
    case 'nome_asc':
      list = [...list].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
      break;
    case 'nome_desc':
      list = [...list].sort((a, b) => b.nome.localeCompare(a.nome, 'pt-BR'));
      break;
    default:
      break;
  }

  state.filteredProducts = list;
  renderProducts();
}

function renderProducts() {
  const grid = document.getElementById('productsGrid');
  const countEl = document.getElementById('resultCount');
  const noResults = document.getElementById('noResults');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  if (!grid) return;

  const total = state.filteredProducts.length;
  const shown = state.filteredProducts.slice(0, state.visibleCount);

  if (countEl) {
    countEl.textContent = `${total} ${total === 1 ? 'produto' : 'produtos'}`;
  }

  if (noResults) {
    noResults.style.display = total === 0 ? 'block' : 'none';
  }

  if (loadMoreBtn) {
    loadMoreBtn.style.display = total > state.visibleCount ? 'inline-block' : 'none';
  }

  const badgeLabels = {
    vendido: 'Mais Vendido',
    novo: 'Novo',
    oferta: 'Oferta',
    esgotado: 'Esgotado'
  };

  grid.innerHTML = shown.map((prod) => {
    const badgeHtml = prod.badge && prod.badge !== 'none'
      ? `<span class="product-badge ${prod.badge}">${badgeLabels[prod.badge] || prod.badge}</span>`
      : '';

    const oldPriceHtml = prod.precoAntigo && prod.precoAntigo > prod.preco
      ? `<span class="product-price-old">${formatBRL(prod.precoAntigo)}</span>`
      : '';

    const isSoldOut = prod.badge === 'esgotado';

    return `
      <article class="product-card" onclick="openProductModal('${String(prod.id).replace(/'/g, "\\'")}')">
        <button type="button" class="card-edit-btn" title="Editar produto" onclick="event.stopPropagation(); quickEditProduct('${String(prod.id).replace(/'/g, "\\'")}')">
          <svg viewBox="0 0 24 24"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
        </button>
        ${badgeHtml}
        <div class="product-img-wrap">
          <img class="product-img" src="${escapeAttr(prod.imagem)}" alt="${escapeAttr(prod.nome)}" loading="lazy">
          <div class="product-overlay">
            <button type="button" class="product-overlay-btn">Ver Detalhes</button>
          </div>
        </div>
        <div class="product-info">
          <p class="product-category-tag">${escapeHtml(prod.categoria)}</p>
          <h3 class="product-name">${escapeHtml(prod.nome)}</h3>
          <p class="product-desc">${escapeHtml(prod.descricao)}</p>
          <div class="product-price-row">
            <span class="product-price">${formatBRL(prod.preco)}</span>
            ${oldPriceHtml}
          </div>
          <button type="button" class="btn-buy" ${isSoldOut ? 'disabled' : ''} onclick="event.stopPropagation(); buyNowSingle('${String(prod.id).replace(/'/g, "\\'")}')">
            ${isSoldOut ? 'Esgotado' : 'Comprar Agora'}
          </button>
          <button type="button" class="btn-cart" ${isSoldOut ? 'disabled' : ''} onclick="event.stopPropagation(); addToCart('${String(prod.id).replace(/'/g, "\\'")}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 01-8 0"></path></svg>
            Adicionar ao Carrinho
          </button>
        </div>
      </article>
    `;
  }).join('');
}

function loadMore() {
  state.visibleCount += INITIAL_LIMIT;
  renderProducts();
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, '&#39;');
}

/* ── MODAL DE PRODUTO ── */
let currentModalProduct = null;

function openProductModal(productId) {
  const prod = state.products.find((p) => String(p.id) === String(productId));
  if (!prod) return;
  currentModalProduct = prod;

  const overlay = document.getElementById('modalOverlay');
  const imgEl = document.getElementById('modalImg');
  const badgeEl = document.getElementById('modalBadge');
  const catEl = document.getElementById('modalCategory');
  const nameEl = document.getElementById('modalName');
  const descEl = document.getElementById('modalDesc');
  const priceEl = document.getElementById('modalPrice');
  const priceOldEl = document.getElementById('modalPriceOld');
  const wppEl = document.getElementById('modalWpp');
  const mpEl = document.getElementById('modalMp');
  const cartBtn = document.getElementById('modalCartBtn');
  const thumbWrap = document.getElementById('modalThumbWrap');
  const thumbsEl = document.getElementById('modalThumbs');

  if (imgEl) {
    imgEl.src = prod.imagem;
    imgEl.alt = prod.nome;
  }

  if (badgeEl) {
    if (prod.badge && prod.badge !== 'none') {
      badgeEl.className = `modal-badge ${prod.badge}`;
      badgeEl.textContent = prod.badge.toUpperCase();
      badgeEl.style.display = 'block';
    } else {
      badgeEl.style.display = 'none';
    }
  }

  if (catEl) catEl.textContent = `${prod.categoria} › ${prod.subcategoria}`;
  if (nameEl) nameEl.textContent = prod.nome;
  if (descEl) descEl.textContent = prod.descricao;
  if (priceEl) priceEl.textContent = formatBRL(prod.preco);

  if (priceOldEl) {
    if (prod.precoAntigo && prod.precoAntigo > prod.preco) {
      priceOldEl.textContent = formatBRL(prod.precoAntigo);
      priceOldEl.style.display = 'inline';
    } else {
      priceOldEl.textContent = '';
      priceOldEl.style.display = 'none';
    }
  }

  const allImgs = [prod.imagem, ...(prod.imagens || [])].filter((u, i, arr) => u && arr.indexOf(u) === i);
  if (thumbWrap && thumbsEl) {
    if (allImgs.length > 1) {
      thumbWrap.classList.add('has-thumbs');
      thumbsEl.innerHTML = allImgs.map((src, idx) => `
        <img class="modal-thumb ${idx === 0 ? 'active' : ''}" src="${escapeAttr(src)}" alt="Miniatura ${idx + 1}" onclick="selectModalThumb('${escapeAttr(src)}', this)">
      `).join('');
    } else {
      thumbWrap.classList.remove('has-thumbs');
      thumbsEl.innerHTML = '';
    }
  }

  const phone = sanitizeDigits(prod.wpp || state.config.wppNumber || DEFAULT_WPP);
  const msg = encodeURIComponent(`Olá! Tenho interesse no produto *${prod.nome}* (${formatBRL(prod.preco)}) da NIMARI.`);
  if (wppEl) {
    wppEl.href = `https://wa.me/${phone}?text=${msg}`;
  }

  if (mpEl) {
    if (prod.mp_link) {
      mpEl.href = prod.mp_link;
      mpEl.style.display = 'flex';
    } else {
      mpEl.style.display = 'none';
    }
  }

  if (cartBtn) {
    cartBtn.classList.remove('added');
    cartBtn.disabled = prod.badge === 'esgotado';
  }

  if (overlay) overlay.classList.add('open');
}

function selectModalThumb(src, thumbEl) {
  const mainImg = document.getElementById('modalImg');
  if (mainImg) mainImg.src = src;
  document.querySelectorAll('.modal-thumb').forEach((t) => t.classList.remove('active'));
  if (thumbEl) thumbEl.classList.add('active');
}

function closeModal() {
  const overlay = document.getElementById('modalOverlay');
  if (overlay) overlay.classList.remove('open');
  currentModalProduct = null;
}

function closeModalOutside(event) {
  if (event.target && event.target.id === 'modalOverlay') {
    closeModal();
  }
}

function addToCartFromModal() {
  if (!currentModalProduct) return;
  addToCart(currentModalProduct.id);
  const btn = document.getElementById('modalCartBtn');
  if (btn) {
    btn.classList.add('added');
    setTimeout(() => btn.classList.remove('added'), 1200);
  }
}

function buyNowSingle(productId) {
  const prod = state.products.find((p) => String(p.id) === String(productId));
  if (!prod) return;
  const phone = sanitizeDigits(prod.wpp || state.config.wppNumber || DEFAULT_WPP);
  const text = encodeURIComponent(`Olá! Quero comprar agora: *${prod.nome}* - ${formatBRL(prod.preco)}.`);
  window.open(`https://wa.me/${phone}?text=${text}`, '_blank', 'noopener,noreferrer');
}

/* ── CARRINHO ── */
function toggleCart() {
  const drawer = document.getElementById('cartDrawer');
  const overlay = document.getElementById('cartOverlay');
  if (drawer) drawer.classList.toggle('open');
  if (overlay) overlay.classList.toggle('open');
}

function addToCart(productId) {
  const prod = state.products.find((p) => String(p.id) === String(productId));
  if (!prod || prod.badge === 'esgotado') return;

  const existing = state.cart.find((item) => String(item.id) === String(prod.id));
  if (existing) {
    existing.qty += 1;
  } else {
    state.cart.push({
      id: prod.id,
      nome: prod.nome,
      descricao: prod.descricao,
      preco: prod.preco,
      imagem: prod.imagem,
      qty: 1
    });
  }

  saveAllToStorage();
  renderCart();
  showToast('Produto adicionado ao carrinho!');
}

function changeCartQty(index, delta) {
  const item = state.cart[index];
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) {
    state.cart.splice(index, 1);
  }
  saveAllToStorage();
  renderCart();
}

function removeCartItem(index) {
  state.cart.splice(index, 1);
  saveAllToStorage();
  renderCart();
}

function clearCart() {
  state.cart = [];
  saveAllToStorage();
  renderCart();
}

function renderCart() {
  const badge = document.getElementById('cartBadge');
  const subEl = document.getElementById('cartSubtitle');
  const emptyEl = document.getElementById('cartEmpty');
  const listEl = document.getElementById('cartList');
  const footerEl = document.getElementById('cartFooter');
  const subtotalEl = document.getElementById('cartSubtotal');
  const totalEl = document.getElementById('cartTotal');

  const totalQty = state.cart.reduce((sum, item) => sum + (item.qty || 0), 0);
  const subtotal = state.cart.reduce((sum, item) => sum + parsePrice(item.preco) * (item.qty || 0), 0);

  if (badge) {
    badge.textContent = String(totalQty);
    badge.style.display = totalQty > 0 ? 'flex' : 'none';
  }

  if (subEl) {
    subEl.textContent = `${totalQty} ${totalQty === 1 ? 'item selecionado' : 'itens selecionados'}`;
  }

  if (!listEl) return;

  if (state.cart.length === 0) {
    if (emptyEl) emptyEl.style.display = 'block';
    listEl.innerHTML = '';
    if (footerEl) footerEl.style.display = 'none';
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  if (footerEl) footerEl.style.display = 'block';

  listEl.innerHTML = state.cart.map((item, idx) => {
    const lineTotal = parsePrice(item.preco) * item.qty;
    return `
      <li class="cart-item">
        <img class="cart-item-img" src="${escapeAttr(item.imagem)}" alt="${escapeAttr(item.nome)}">
        <div>
          <p class="cart-item-name">${escapeHtml(item.nome)}</p>
          <p class="cart-item-desc">${escapeHtml(item.descricao)}</p>
          <p class="cart-item-price">${formatBRL(item.preco)}</p>
        </div>
        <div class="cart-item-controls">
          <div class="cart-qty-row">
            <button type="button" class="cart-qty-btn" onclick="changeCartQty(${idx}, -1)">-</button>
            <span class="cart-qty-num">${item.qty}</span>
            <button type="button" class="cart-qty-btn" onclick="changeCartQty(${idx}, 1)">+</button>
          </div>
          <span class="cart-item-line-total">${formatBRL(lineTotal)}</span>
          <button type="button" class="cart-item-remove" onclick="removeCartItem(${idx})">Remover</button>
        </div>
      </li>
    `;
  }).join('');

  if (subtotalEl) subtotalEl.textContent = formatBRL(subtotal);
  if (totalEl) totalEl.textContent = formatBRL(subtotal);
}

function finalizeOrder() {
  const nameInput = document.getElementById('cartCustomerName');
  const addrInput = document.getElementById('cartCustomerAddress');

  const nome = (nameInput ? nameInput.value : '').trim();
  const endereco = (addrInput ? addrInput.value : '').trim();

  if (nameInput) nameInput.classList.toggle('error', !nome);
  if (addrInput) addrInput.classList.toggle('error', !endereco);

  if (!nome || !endereco) {
    showToast('Preencha seu nome e endereço para finalizar.');
    return false;
  }

  if (state.cart.length === 0) return false;

  const total = state.cart.reduce((sum, item) => sum + parsePrice(item.preco) * item.qty, 0);
  const linhasItens = state.cart.map((item) =>
    `• ${item.qty}x ${item.nome} — ${formatBRL(parsePrice(item.preco) * item.qty)}`
  ).join('\n');

  const mensagem = [
    '*NOVO PEDIDO – NIMARI*',
    `*Cliente:* ${nome}`,
    `*Endereço:* ${endereco}`,
    '',
    '*Itens:*',
    linhasItens,
    '',
    `*Total:* ${formatBRL(total)}`
  ].join('\n');

  const phone = sanitizeDigits(state.config.wppNumber || DEFAULT_WPP) || DEFAULT_WPP;
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(mensagem)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
  return false;
}

/* ── MENU MOBILE, FAQ E WHATSAPP ── */
function closeMobile() {
  const menu = document.getElementById('mobileMenu');
  const burger = document.getElementById('hamburger');
  if (menu) menu.classList.remove('open');
  if (burger) burger.classList.remove('open');
}

function initMobileMenu() {
  const burger = document.getElementById('hamburger');
  const menu = document.getElementById('mobileMenu');
  if (!burger || !menu) return;

  burger.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
    burger.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    if (menu.classList.contains('open') && !menu.contains(e.target) && !burger.contains(e.target)) {
      closeMobile();
    }
  });
}

function toggleFaq(el) {
  const item = el && el.closest('.faq-item');
  if (item) item.classList.toggle('open');
}

function applyWppLinks() {
  const phone = sanitizeDigits(state.config.wppNumber || DEFAULT_WPP) || DEFAULT_WPP;
  document.querySelectorAll('a[href*="wa.me/"]').forEach((link) => {
    const rawHref = link.getAttribute('href') || '';
    const qIdx = rawHref.indexOf('?');
    const query = qIdx >= 0 ? rawHref.slice(qIdx) : '?text=Ol%C3%A1!%20Vim%20pelo%20site%20da%20NIMARI!';
    link.setAttribute('href', `https://wa.me/${phone}${query}`);
  });
}

function applyAboutImage() {
  if (!state.config.aboutImage) return;
  const img = document.getElementById('aboutSectionImg');
  if (img) img.src = state.config.aboutImage;
}

/* ── PAINEL ADMIN E DEPOIMENTOS ── */
function openAdminLogin() {
  const overlay = document.getElementById('adminLoginOverlay');
  const errEl = document.getElementById('adminLoginErr');
  const pwdEl = document.getElementById('adminPwdInput');
  if (errEl) errEl.style.display = 'none';
  if (pwdEl) pwdEl.value = '';
  if (overlay) overlay.classList.add('open');
}

function closeAdminLogin() {
  const overlay = document.getElementById('adminLoginOverlay');
  if (overlay) overlay.classList.remove('open');
}

async function adminLogin() {
  const now = Date.now();
  if (now < state.lockUntil) {
    showToast('Muitas tentativas. Aguarde alguns instantes.');
    return;
  }

  const pwdEl = document.getElementById('adminPwdInput');
  const errEl = document.getElementById('adminLoginErr');
  const pwd = (pwdEl ? pwdEl.value : '').trim();
  if (!pwd) return;

  let authenticated = false;

  if (API_URL) {
    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.token) sessionStorage.setItem(STORAGE_KEYS.token, data.token);
        authenticated = true;
      }
    } catch (err) {
      console.warn('Falha na autenticação remota:', err);
    }
  } else {
    // Fallback local quando não há API configurada
    sessionStorage.setItem(STORAGE_KEYS.token, btoa(`nimari:${Date.now()}`));
    authenticated = pwd.length >= 4;
  }

  if (authenticated) {
    state.isAdmin = true;
    state.loginAttempts = 0;
    document.body.classList.add('admin-mode-active');
    closeAdminLogin();
    openAdminPanel();
  } else {
    state.loginAttempts += 1;
    if (state.loginAttempts >= 5) {
      state.lockUntil = Date.now() + 60000;
      state.loginAttempts = 0;
    }
    if (errEl) errEl.style.display = 'block';
  }
}

function openAdminPanel() {
  const panel = document.getElementById('adminPanel');
  if (panel) panel.classList.add('open');
  renderAdminProductList();
  renderDepoList();
  renderConfigTab();
}

function closeAdminPanel() {
  const panel = document.getElementById('adminPanel');
  if (panel) panel.classList.remove('open');
}

function adminLogout() {
  state.isAdmin = false;
  sessionStorage.removeItem(STORAGE_KEYS.token);
  document.body.classList.remove('admin-mode-active');
  closeAdminPanel();
  showToast('Sessão encerrada.');
}

function switchTab(tabName) {
  const tabMap = {
    edit: 0,
    add: 1,
    depo: 2,
    config: 3
  };

  document.querySelectorAll('.admin-tab').forEach((btn, i) => {
    btn.classList.toggle('active', i === tabMap[tabName]);
  });

  document.querySelectorAll('.admin-tab-content').forEach((content) => {
    content.classList.remove('active');
  });

  const target = document.getElementById(`tab-${tabName}`);
  if (target) target.classList.add('active');

  if (tabName === 'edit') {
    showAdminList();
    renderAdminProductList();
  } else if (tabName === 'depo') {
    renderDepoList();
  } else if (tabName === 'config') {
    renderConfigTab();
  }
}

function showAdminList() {
  const listWrap = document.getElementById('adminProdList');
  const formWrap = document.getElementById('adminEditForm');
  if (listWrap) listWrap.style.display = 'block';
  if (formWrap) formWrap.classList.remove('active');
  editingProductId = null;
}

function renderAdminProductList() {
  const inner = document.getElementById('adminProdListInner');
  if (!inner) return;

  if (state.products.length === 0) {
    inner.innerHTML = '<p class="admin-list-hint">Nenhum produto cadastrado ainda.</p>';
    return;
  }

  inner.innerHTML = state.products.map((p) => `
    <div class="admin-prod-item" onclick="startEditProduct('${String(p.id).replace(/'/g, "\\'")}')">
      <img class="admin-prod-thumb" src="${escapeAttr(p.imagem)}" alt="${escapeAttr(p.nome)}">
      <div class="admin-prod-info">
        <p class="admin-prod-item-name">${escapeHtml(p.nome)}</p>
        <p class="admin-prod-item-cat">${escapeHtml(p.categoria)} › ${escapeHtml(p.subcategoria)}</p>
      </div>
      <span class="admin-prod-price-tag">${formatBRL(p.preco)}</span>
    </div>
  `).join('');
}

function quickEditProduct(productId) {
  if (!state.isAdmin) {
    openAdminLogin();
    return;
  }
  openAdminPanel();
  switchTab('edit');
  startEditProduct(productId);
}

function syncEditSubOptions(selectedSub) {
  const catEl = document.getElementById('editCat');
  const subEl = document.getElementById('editSub');
  if (!catEl || !subEl) return;

  const subs = SUBCATEGORIES_BY_CAT[catEl.value] || [];
  subEl.innerHTML = subs.map((s) => `<option value="${s.value}">${s.label}</option>`).join('');
  if (selectedSub && subs.some((s) => s.value === selectedSub)) {
    subEl.value = selectedSub;
  }
}

function startEditProduct(productId) {
  const prod = state.products.find((p) => String(p.id) === String(productId));
  if (!prod) return;

  editingProductId = prod.id;
  editExtraImgs = [...(prod.imagens || [])];
  selectedBadgeEdit = prod.badge || 'none';

  const listWrap = document.getElementById('adminProdList');
  const formWrap = document.getElementById('adminEditForm');
  if (listWrap) listWrap.style.display = 'none';
  if (formWrap) formWrap.classList.add('active');

  document.getElementById('editImgUrl').value = prod.imagem || '';
  document.getElementById('editName').value = prod.nome || '';
  document.getElementById('editDesc').value = prod.descricao || '';
  document.getElementById('editPrice').value = String(prod.preco || '').replace('.', ',');
  document.getElementById('editPriceOld').value = prod.precoAntigo ? String(prod.precoAntigo).replace('.', ',') : '';
  document.getElementById('editCat').value = prod.categoria || 'cosmeticos';
  syncEditSubOptions(prod.subcategoria);
  document.getElementById('editWpp').value = prod.wpp || state.config.wppNumber || DEFAULT_WPP;
  document.getElementById('editMpLink').value = prod.mp_link || '';

  previewImageUrl('edit');
  renderExtraImgsList('edit');

  document.querySelectorAll('#adminEditForm .badge-opt').forEach((opt) => {
    opt.classList.toggle('sel', opt.getAttribute('data-val') === selectedBadgeEdit);
  });
}

async function saveProductEdits() {
  if (!editingProductId) return;
  const idx = state.products.findIndex((p) => String(p.id) === String(editingProductId));
  if (idx === -1) return;

  const current = state.products[idx];
  const imgVal = document.getElementById('editImgUrl').value.trim() || current.imagem;
  const priceOldRaw = document.getElementById('editPriceOld').value.trim();

  const updated = normalizeProduct({
    ...current,
    imagem: imgVal,
    imagens: [...editExtraImgs],
    nome: document.getElementById('editName').value.trim() || current.nome,
    descricao: document.getElementById('editDesc').value.trim(),
    preco: parsePrice(document.getElementById('editPrice').value),
    precoAntigo: priceOldRaw ? parsePrice(priceOldRaw) : null,
    categoria: document.getElementById('editCat').value,
    subcategoria: document.getElementById('editSub').value,
    wpp: sanitizeDigits(document.getElementById('editWpp').value) || state.config.wppNumber,
    mp_link: document.getElementById('editMpLink').value.trim(),
    badge: selectedBadgeEdit
  }, idx);

  if (API_URL) {
    try {
      await fetch(`${API_URL}/produtos/${encodeURIComponent(updated.id)}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(updated)
      });
    } catch (err) {
      console.warn('Erro ao atualizar produto na API:', err);
    }
  }

  state.products[idx] = updated;
  saveAllToStorage();
  updateSubcategoryCounts();
  applySortAndFilter();
  renderAdminProductList();
  showToast('Produto atualizado com sucesso!');
}

async function deleteProduct() {
  if (!editingProductId) return;
  const idToDelete = editingProductId;

  if (API_URL) {
    try {
      await fetch(`${API_URL}/produtos/${encodeURIComponent(idToDelete)}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
    } catch (err) {
      console.warn('Erro ao excluir produto na API:', err);
    }
  }

  state.products = state.products.filter((p) => String(p.id) !== String(idToDelete));
  saveAllToStorage();
  updateSubcategoryCounts();
  applySortAndFilter();
  renderAdminProductList();
  showAdminList();
  showToast('Produto removido.');
}

async function addNewProduct() {
  const nome = document.getElementById('addName').value.trim();
  const precoRaw = document.getElementById('addPrice').value.trim();

  if (!nome || !precoRaw) {
    showToast('Informe pelo menos nome e preço do produto.');
    return;
  }

  const priceOldRaw = document.getElementById('addPriceOld').value.trim();
  const imgUrl = document.getElementById('addImgUrl').value.trim();

  let newProd = normalizeProduct({
    id: `prod-${Date.now()}`,
    nome,
    descricao: document.getElementById('addDesc').value.trim(),
    preco: parsePrice(precoRaw),
    precoAntigo: priceOldRaw ? parsePrice(priceOldRaw) : null,
    categoria: document.getElementById('addCat').value,
    subcategoria: document.getElementById('addSub').value,
    imagem: imgUrl || undefined,
    imagens: [...addExtraImgs],
    wpp: sanitizeDigits(document.getElementById('addWpp').value) || state.config.wppNumber,
    mp_link: document.getElementById('addMpLink').value.trim(),
    badge: selectedBadgeAdd,
    createdAt: Date.now()
  });

  if (API_URL) {
    try {
      const res = await fetch(`${API_URL}/produtos`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(newProd)
      });
      if (res.ok) {
        const created = await res.json();
        newProd = normalizeProduct({ ...newProd, ...created });
      }
    } catch (err) {
      console.warn('Erro ao criar produto na API:', err);
    }
  }

  state.products.unshift(newProd);
  saveAllToStorage();
  updateSubcategoryCounts();
  applySortAndFilter();
  renderAdminProductList();
  resetAddForm();
  showToast('Novo produto adicionado!');
}

function resetAddForm() {
  ['addImgUrl', 'addExtraImgUrl', 'addName', 'addDesc', 'addPrice', 'addPriceOld', 'addWpp', 'addMpLink'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  addExtraImgs = [];
  selectedBadgeAdd = 'none';
  previewImageUrl('add');
  renderExtraImgsList('add');
  document.querySelectorAll('#addBadgeSelector .badge-opt').forEach((opt) => {
    opt.classList.toggle('sel', opt.getAttribute('data-val') === 'none');
  });
}

function previewImageUrl(mode) {
  const urlEl = document.getElementById(`${mode}ImgUrl`);
  const prevEl = document.getElementById(`${mode}ImgPreview`);
  const placeEl = document.getElementById(`${mode}ImgPlaceholder`);
  if (!urlEl || !prevEl) return;

  const val = urlEl.value.trim();
  if (val) {
    prevEl.src = val;
    prevEl.classList.add('show');
    if (placeEl) placeEl.style.display = 'none';
  } else {
    prevEl.src = '';
    prevEl.classList.remove('show');
    if (placeEl) placeEl.style.display = 'block';
  }
}

function uploadImagem(mode) {
  const fileInput = document.getElementById(`${mode}ImgFile`);
  const file = fileInput && fileInput.files && fileInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const urlEl = document.getElementById(`${mode}ImgUrl`);
    if (urlEl) urlEl.value = e.target.result;
    previewImageUrl(mode);
  };
  reader.readAsDataURL(file);
}

function editAddExtraImgUrl() {
  const inp = document.getElementById('editExtraImgUrl');
  const val = (inp ? inp.value : '').trim();
  if (!val) return;
  editExtraImgs.push(val);
  inp.value = '';
  renderExtraImgsList('edit');
}

function addAddExtraImgUrl() {
  const inp = document.getElementById('addExtraImgUrl');
  const val = (inp ? inp.value : '').trim();
  if (!val) return;
  addExtraImgs.push(val);
  inp.value = '';
  renderExtraImgsList('add');
}

function editUploadExtraImg(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    editExtraImgs.push(e.target.result);
    renderExtraImgsList('edit');
  };
  reader.readAsDataURL(file);
}

function addUploadExtraImg(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    addExtraImgs.push(e.target.result);
    renderExtraImgsList('add');
  };
  reader.readAsDataURL(file);
}

function removeExtraImg(mode, index) {
  if (mode === 'edit') {
    editExtraImgs.splice(index, 1);
    renderExtraImgsList('edit');
  } else {
    addExtraImgs.splice(index, 1);
    renderExtraImgsList('add');
  }
}

function renderExtraImgsList(mode) {
  const listEl = document.getElementById(`${mode}ExtraImgsList`);
  if (!listEl) return;
  const arr = mode === 'edit' ? editExtraImgs : addExtraImgs;

  listEl.innerHTML = arr.map((src, idx) => `
    <div class="extra-img-row">
      <img class="extra-img-thumb" src="${escapeAttr(src)}" alt="Extra ${idx + 1}">
      <span class="extra-img-url">${escapeHtml(src)}</span>
      <button type="button" class="extra-img-del" onclick="removeExtraImg('${mode}', ${idx})">×</button>
    </div>
  `).join('');
}

/* ── DEPOIMENTOS (COM DELETE COMPLETO NA API) ── */
function renderDepoList() {
  const listEl = document.getElementById('depoList');
  if (!listEl) return;

  if (state.depoimentos.length === 0) {
    listEl.innerHTML = '<p class="admin-list-hint">Nenhum depoimento cadastrado.</p>';
    return;
  }

  listEl.innerHTML = state.depoimentos.map((d, idx) => `
    <div class="admin-prod-item" onclick="openDepoForm(${idx})">
      <img class="admin-prod-thumb" src="${escapeAttr(d.avatar || 'https://uiickpwlwsayewcukiog.supabase.co/storage/v1/object/public/Marcas/NIMARI%20(1).png')}" alt="${escapeAttr(d.name || 'Cliente')}">
      <div class="admin-prod-info">
        <p class="admin-prod-item-name">${escapeHtml(d.name || 'Cliente NIMARI')}</p>
        <p class="admin-prod-item-cat">${'★'.repeat(d.stars || 5)} • ${escapeHtml(d.loc || '')}</p>
      </div>
    </div>
  `).join('');
}

function openDepoForm(index) {
  editingDepoIndex = index;
  const form = document.getElementById('depoForm');
  const title = document.getElementById('depoFormTitle');
  const delBtn = document.getElementById('depoDeleteBtn');
  const preview = document.getElementById('depoAvatarPreview');

  if (index >= 0 && state.depoimentos[index]) {
    const d = state.depoimentos[index];
    selectedDepoStars = Number(d.stars) || 5;
    pendingDepoAvatar = d.avatar || '';
    if (title) title.textContent = 'Editando depoimento';
    if (delBtn) delBtn.style.display = 'inline-block';
    document.getElementById('depoText').value = d.text || '';
    document.getElementById('depoName').value = d.name || '';
    document.getElementById('depoLoc').value = d.loc || '';
    document.getElementById('depoDate').value = d.date || '';
  } else {
    selectedDepoStars = 5;
    pendingDepoAvatar = '';
    if (title) title.textContent = 'Novo depoimento';
    if (delBtn) delBtn.style.display = 'none';
    document.getElementById('depoText').value = '';
    document.getElementById('depoName').value = '';
    document.getElementById('depoLoc').value = '';
    document.getElementById('depoDate').value = new Date().toLocaleDateString('pt-BR');
  }

  if (preview) {
    preview.src = pendingDepoAvatar || 'https://uiickpwlwsayewcukiog.supabase.co/storage/v1/object/public/Marcas/NIMARI%20(1).png';
  }

  updateDepoStarsUI();
  if (form) form.style.display = 'block';
}

function showDepoList() {
  const form = document.getElementById('depoForm');
  if (form) form.style.display = 'none';
  editingDepoIndex = -1;
}

function updateDepoStarsUI() {
  document.querySelectorAll('#depoStarSelector span').forEach((span) => {
    const val = Number(span.getAttribute('data-star'));
    span.style.color = val <= selectedDepoStars ? 'var(--gold)' : 'var(--rose-dark)';
  });
}

function previewDepoAvatar() {
  const fileInput = document.getElementById('depoAvatarFile');
  const file = fileInput && fileInput.files && fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    pendingDepoAvatar = e.target.result;
    const prev = document.getElementById('depoAvatarPreview');
    if (prev) prev.src = pendingDepoAvatar;
  };
  reader.readAsDataURL(file);
}

async function saveDepo() {
  const text = document.getElementById('depoText').value.trim();
  const name = document.getElementById('depoName').value.trim();
  const loc = document.getElementById('depoLoc').value.trim();
  const date = document.getElementById('depoDate').value.trim();

  if (!text || !name) {
    showToast('Preencha o nome e o texto do depoimento.');
    return;
  }

  const existingItem = editingDepoIndex >= 0 ? state.depoimentos[editingDepoIndex] : null;
  let depoObj = {
    id: existingItem && existingItem.id ? existingItem.id : `depo-${Date.now()}`,
    avatar: pendingDepoAvatar || (existingItem && existingItem.avatar) || '',
    stars: selectedDepoStars,
    text,
    name,
    loc,
    date
  };

  if (API_URL) {
    try {
      const isUpdate = Boolean(existingItem && existingItem.id);
      const url = isUpdate
        ? `${API_URL}/depoimentos/${encodeURIComponent(existingItem.id)}`
        : `${API_URL}/depoimentos`;
      const method = isUpdate ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: getAuthHeaders(),
        body: JSON.stringify(depoObj)
      });
      if (res.ok) {
        const saved = await res.json();
        depoObj = { ...depoObj, ...saved };
      }
    } catch (err) {
      console.warn('Erro ao salvar depoimento na API:', err);
    }
  }

  if (editingDepoIndex >= 0) {
    state.depoimentos[editingDepoIndex] = depoObj;
  } else {
    state.depoimentos.unshift(depoObj);
  }

  saveAllToStorage();
  renderDepoList();
  showDepoList();
  showToast('Depoimento salvo com sucesso!');
}

async function deleteDepo() {
  if (editingDepoIndex < 0 || !state.depoimentos[editingDepoIndex]) return;
  const target = state.depoimentos[editingDepoIndex];

  if (API_URL && target.id) {
    try {
      const res = await fetch(`${API_URL}/depoimentos/${encodeURIComponent(target.id)}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      if (!res.ok) {
        console.warn('Falha ao excluir depoimento na API:', res.status);
      }
    } catch (err) {
      console.warn('Erro ao excluir depoimento na API:', err);
    }
  }

  state.depoimentos.splice(editingDepoIndex, 1);
  saveAllToStorage();
  renderDepoList();
  showDepoList();
  showToast('Depoimento excluído.');
}

/* ── CONFIGURAÇÕES, EXCEL E EXCLUSÃO EM MASSA ── */
function renderConfigTab() {
  const wppInp = document.getElementById('configWppNumber');
  const wppPrev = document.getElementById('configWppPreview');
  if (wppInp) wppInp.value = state.config.wppNumber || DEFAULT_WPP;
  if (wppPrev) wppPrev.textContent = `Link ativo: https://wa.me/${state.config.wppNumber || DEFAULT_WPP}`;

  const catList = document.getElementById('catVisibilityList');
  if (catList) {
    const cats = [
      { key: 'cosmeticos', label: 'Cosméticos' },
      { key: 'confeccao', label: 'Confecção' },
      { key: 'kit', label: 'Kit' }
    ];
    catList.innerHTML = cats.map((c) => {
      const checked = !state.config.hiddenCategories.includes(c.key);
      return `
        <div class="admin-inline-row" style="justify-content:space-between;">
          <span style="color:#fff;font-size:.8rem;">${c.label}</span>
          <label class="cat-toggle">
            <input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleCategoryVisibility('${c.key}', this.checked)">
            <span class="cat-toggle-slider"></span>
          </label>
        </div>
      `;
    }).join('');
  }
}

function toggleCategoryVisibility(catKey, isVisible) {
  if (isVisible) {
    state.config.hiddenCategories = state.config.hiddenCategories.filter((k) => k !== catKey);
  } else if (!state.config.hiddenCategories.includes(catKey)) {
    state.config.hiddenCategories.push(catKey);
  }
  saveAllToStorage();
  applySortAndFilter();
}

function saveWppConfig() {
  const inp = document.getElementById('configWppNumber');
  const digits = sanitizeDigits(inp ? inp.value : '');
  if (!digits) {
    showToast('Informe um número de WhatsApp válido.');
    return;
  }
  state.config.wppNumber = digits;
  saveAllToStorage();
  applyWppLinks();
  renderConfigTab();
  showToast('Número do WhatsApp atualizado!');
}

function previewAboutImage() {
  const fileInput = document.getElementById('aboutImgFile');
  const file = fileInput && fileInput.files && fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    pendingAboutImage = e.target.result;
    const prev = document.getElementById('aboutImgPreview');
    const place = document.getElementById('aboutImgPlaceholder');
    if (prev) {
      prev.src = pendingAboutImage;
      prev.classList.add('show');
    }
    if (place) place.style.display = 'none';
  };
  reader.readAsDataURL(file);
}

function saveAboutImage() {
  if (!pendingAboutImage) {
    showToast('Selecione uma imagem primeiro.');
    return;
  }
  state.config.aboutImage = pendingAboutImage;
  saveAllToStorage();
  applyAboutImage();
  showToast('Imagem da seção Sobre salva!');
}

function adicionarMarca() {
  const nomeEl = document.getElementById('novaMarcaNome');
  const logoEl = document.getElementById('novaMarcaLogo');
  const nome = (nomeEl ? nomeEl.value : '').trim();
  const logo = (logoEl ? logoEl.value : '').trim();
  if (!nome) return;

  state.config.brands.push({ nome, logo });
  if (nomeEl) nomeEl.value = '';
  if (logoEl) logoEl.value = '';
  saveAllToStorage();
  showToast('Marca adicionada!');
}

function exportarProdutosXlsx() {
  if (typeof XLSX === 'undefined') {
    showToast('Biblioteca XLSX não carregada.');
    return;
  }
  const rows = state.products.map((p) => ({
    id: p.id,
    nome: p.nome,
    descricao: p.descricao,
    preco: p.preco,
    precoAntigo: p.precoAntigo || '',
    categoria: p.categoria,
    subcategoria: p.subcategoria,
    badge: p.badge,
    wpp: p.wpp,
    mp_link: p.mp_link,
    imagem: p.imagem
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Produtos');
  XLSX.writeFile(wb, 'nimari_produtos.xlsx');
}

function downloadCsvTemplate() {
  if (typeof XLSX === 'undefined') return;
  const sample = [{
    nome: 'Perfume Floral Nimari',
    descricao: 'Fragrância marcante e elegante',
    preco: 79.9,
    precoAntigo: 99.9,
    categoria: 'cosmeticos',
    subcategoria: 'perf-fem',
    badge: 'novo',
    wpp: state.config.wppNumber || DEFAULT_WPP,
    mp_link: '',
    imagem: ''
  }];
  const ws = XLSX.utils.json_to_sheet(sample);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Modelo');
  XLSX.writeFile(wb, 'modelo_importacao_nimari.xlsx');
}

function handleCsvFile(file) {
  if (!file || typeof XLSX === 'undefined') return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const data = new Uint8Array(e.target.result);
    const wb = XLSX.read(data, { type: 'array' });
    const firstSheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet);

    pendingBatchProducts = rows
      .filter((r) => r && (r.nome || r.name) && (r.preco || r.price))
      .map((r, i) => normalizeProduct({
        id: `batch-${Date.now()}-${i}`,
        nome: r.nome || r.name,
        descricao: r.descricao || r.desc || '',
        preco: r.preco || r.price,
        precoAntigo: r.precoAntigo || r.preco_antigo || null,
        categoria: r.categoria || 'cosmeticos',
        subcategoria: r.subcategoria || 'outros-cosm',
        badge: r.badge || 'none',
        wpp: r.wpp || state.config.wppNumber,
        mp_link: r.mp_link || '',
        imagem: r.imagem || ''
      }, i));

    const area = document.getElementById('csvPreviewArea');
    const info = document.getElementById('csvPreviewInfo');
    if (area) area.style.display = pendingBatchProducts.length ? 'block' : 'none';
    if (info) info.textContent = `${pendingBatchProducts.length} produto(s) prontos para importar.`;
  };
  reader.readAsArrayBuffer(file);
}

function executarImportacaoLote() {
  if (!pendingBatchProducts.length) return;
  state.products = [...pendingBatchProducts, ...state.products];
  pendingBatchProducts = [];
  saveAllToStorage();
  updateSubcategoryCounts();
  applySortAndFilter();
  renderAdminProductList();
  cancelarCsvImport();
  showToast('Produtos importados com sucesso!');
}

function cancelarCsvImport() {
  pendingBatchProducts = [];
  const area = document.getElementById('csvPreviewArea');
  const inp = document.getElementById('csvFileInput');
  if (area) area.style.display = 'none';
  if (inp) inp.value = '';
}

async function excluirTodosProdutos() {
  if (API_URL) {
    try {
      await fetch(`${API_URL}/produtos`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
    } catch (err) {
      console.warn('Erro ao limpar produtos na API:', err);
    }
  }
  state.products = [];
  saveAllToStorage();
  updateSubcategoryCounts();
  applySortAndFilter();
  renderAdminProductList();
  showToast('Todos os produtos foram removidos.');
}

/* ── INICIALIZAÇÃO ── */
document.addEventListener('DOMContentLoaded', () => {
  initMobileMenu();
  loadSavedConfig();
  loadSavedProducts();

  document.querySelectorAll('#adminEditForm .badge-opt').forEach((opt) => {
    opt.addEventListener('click', () => {
      selectedBadgeEdit = opt.getAttribute('data-val') || 'none';
      document.querySelectorAll('#adminEditForm .badge-opt').forEach((el) => el.classList.remove('sel'));
      opt.classList.add('sel');
    });
  });

  document.querySelectorAll('#addBadgeSelector .badge-opt').forEach((opt) => {
    opt.addEventListener('click', () => {
      selectedBadgeAdd = opt.getAttribute('data-val') || 'none';
      document.querySelectorAll('#addBadgeSelector .badge-opt').forEach((el) => el.classList.remove('sel'));
      opt.classList.add('sel');
    });
  });

  document.querySelectorAll('#depoStarSelector span').forEach((starEl) => {
    starEl.addEventListener('click', () => {
      selectedDepoStars = Number(starEl.getAttribute('data-star')) || 5;
      updateDepoStarsUI();
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      closeMobile();
    }
  });
});