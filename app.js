(function () {
  const DEFAULT_WPP = '5598985631126';
  const API_URL =
    typeof window.NIMARI_API_URL === 'string' && window.NIMARI_API_URL
      ? window.NIMARI_API_URL.replace(/\/$/, '')
      : '/api';

  const STORAGE_KEYS = {
    products: 'nimari_produtos_v1',
    config: 'nimari_config_v1',
    cart: 'nimari_cart_v1',
    depoimentos: 'nimari_depoimentos_v1',
  };

  const SUBCAT_LABELS = {
    'pele': 'Cosméticos › Cuidados com a Pele',
    'cabelo': 'Cosméticos › Cuidados com o Cabelo',
    'perf-fem': 'Cosméticos › Perfumaria Feminina',
    'perf-masc': 'Cosméticos › Perfumaria Masculina',
    'infantil-cosm': 'Cosméticos › Infantil',
    'outros-cosm': 'Cosméticos › Outros',
    'intima-fem': 'Confecção › Moda Íntima Feminina',
    'intima-inf': 'Confecção › Moda Íntima Infantil',
    'sutia': 'Confecção › Sutiã',
    'calcinha': 'Confecção › Calcinha',
    'outros-conf': 'Confecção › Outros',
    'kit-presente': 'Kit › Kit Presente',
  };

  const CAT_SUBS = {
    cosmeticos: [
      { value: 'pele', label: 'Cuidados com a Pele' },
      { value: 'cabelo', label: 'Cuidados com o Cabelo' },
      { value: 'perf-fem', label: 'Perfumaria Feminina' },
      { value: 'perf-masc', label: 'Perfumaria Masculina' },
      { value: 'infantil-cosm', label: 'Cosméticos Infantil' },
      { value: 'outros-cosm', label: 'Outros Cosméticos' },
    ],
    confeccao: [
      { value: 'intima-fem', label: 'Moda Íntima Feminina' },
      { value: 'intima-inf', label: 'Moda Íntima Infantil' },
      { value: 'sutia', label: 'Sutiã' },
      { value: 'calcinha', label: 'Calcinha' },
      { value: 'outros-conf', label: 'Outros Confecção' },
    ],
    kit: [
      { value: 'kit-presente', label: 'Kit Presente' },
    ],
  };

  window.state = window.state || {
    produtos: [],
    filtered: [],
    cart: [],
    depoimentos: [],
    filterCat: 'all',
    filterSub: 'all',
    filterLabel: 'Todos os Produtos',
    searchQuery: '',
    sortBy: 'relevancia',
    visibleCount: 12,
    activeProduct: null,
    activeImage: '',
    config: {
      wppNumber: DEFAULT_WPP,
      aboutImage: '',
      hiddenCategories: [],
      brands: [],
    },
  };
  const state = window.state;

  let adminSessionToken = sessionStorage.getItem('nimari_admin_token') || '';
  let pendingAboutImage = '';
  let editingCard = null;
  let editExtraImgs = [];
  let addExtraImgs = [];
  let currentBadge = 'none';
  let addBadge = 'none';

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }

  function sanitizeDigits(val) {
    return String(val ?? '').replace(/\D+/g, '');
  }

  function parsePriceNum(val) {
    if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
    if (!val) return 0;
    const raw = String(val).trim();
    if (/^\d{1,3}(\.\d{3})*,\d{1,2}$/.test(raw)) {
      const n = Number(raw.replace(/\./g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : 0;
    }
    const cleaned = raw.replace(/,/g, '.').replace(/[^0-9.-]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }

  function formatBRL(num) {
    const val = Number.isFinite(num) ? num : 0;
    return val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function normalizeCategory(cat) {
    const c = String(cat || 'cosmeticos').trim().toLowerCase();
    if (c.includes('confec') || c.includes('intima') || c.includes('moda')) return 'confeccao';
    if (c.includes('kit')) return 'kit';
    return 'cosmeticos';
  }

  function normalizeProduct(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const precoNum = parsePriceNum(raw.preco ?? raw.price ?? 0);
    const priceStr =
      raw.price !== undefined && raw.price !== null && String(raw.price).trim() !== ''
        ? String(raw.price)
        : precoNum.toFixed(2).replace('.', ',');

    const imgList = Array.isArray(raw.imagens)
      ? raw.imagens.filter(Boolean).map(String)
      : typeof raw.imagens === 'string' && raw.imagens.trim()
        ? raw.imagens.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

    const mainImg = String(raw.imagem || imgList[0] || '').trim();
    const allImgs = mainImg ? [mainImg, ...imgList.filter((u) => u !== mainImg)] : imgList;

    const nome = String(raw.nome ?? raw.name ?? 'Produto').trim() || 'Produto';
    const cat = normalizeCategory(raw.categoria ?? raw.cat ?? 'cosmeticos');
    const sub = String(raw.subcategoria ?? raw.sub ?? '').trim();

    return {
      ...raw,
      id: raw.id ?? raw.uid ?? `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      uid: raw.uid ?? String(raw.id ?? ''),
      nome,
      name: nome,
      descricao: String(raw.descricao ?? raw.desc ?? '').trim(),
      categoria: cat,
      subcategoria: sub,
      preco: precoNum,
      price: priceStr,
      priceOld: raw.priceOld ?? raw.preco_antigo ?? '',
      badge: raw.badge ?? raw.tag ?? 'none',
      wpp: sanitizeDigits(raw.wpp || ''),
      mpLink: String(raw.mpLink ?? raw.mp_link ?? '').trim(),
      imagem: mainImg,
      imagens: allImgs,
      created_at: raw.created_at || new Date().toISOString(),
    };
  }

  function saveAllToStorage() {
    try {
      localStorage.setItem(STORAGE_KEYS.products, JSON.stringify(state.produtos));
      localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(state.config));
      localStorage.setItem(STORAGE_KEYS.cart, JSON.stringify(state.cart));
      localStorage.setItem(STORAGE_KEYS.depoimentos, JSON.stringify(state.depoimentos));
    } catch (_) {}
  }

  function showToast(msg) {
    const el = document.getElementById('adminToast');
    if (el) {
      el.textContent = msg;
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 2600);
    }
  }

  function assertAdminSession() {
    adminSessionToken = sessionStorage.getItem('nimari_admin_token') || adminSessionToken || '';
    if (!adminSessionToken) {
      window.openAdminLogin?.();
      return false;
    }
    return true;
  }

  async function adminFetch(url, options = {}) {
    const token = sessionStorage.getItem('nimari_admin_token') || adminSessionToken || '';
    const headers = new Headers(options.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(url, { ...options, headers });
  }

  /* ── FILTROS, ORDENAÇÃO E RENDERIZAÇÃO DA VITRINE ── */
  window.toggleGroup = function (groupId) {
    const btn = document.getElementById(`grp-${groupId}`);
    const sub = document.getElementById(`sub-${groupId}`);
    if (!btn || !sub) return;
    const isOpen = btn.classList.toggle('open');
    sub.classList.toggle('open', isOpen);
    const chev = btn.querySelector('.chevron');
    if (chev) chev.textContent = isOpen ? '▲' : '▼';
  };

  window.setFilter = function (cat, sub, label) {
    state.filterCat = cat || 'all';
    state.filterSub = sub || 'all';
    state.filterLabel = label || 'Todos os Produtos';
    state.visibleCount = 12;

    const btnAll = document.getElementById('btnAll');
    const subItems = document.querySelectorAll('.sidebar-sub-item');

    if (state.filterCat === 'all' && state.filterSub === 'all') {
      btnAll?.classList.add('active');
      subItems.forEach((el) => el.classList.remove('active'));
    } else {
      btnAll?.classList.remove('active');
      subItems.forEach((el) => {
        const match =
          el.dataset.filter === state.filterCat &&
          (state.filterSub === 'all' || el.dataset.sub === state.filterSub);
        el.classList.toggle('active', Boolean(match));
      });
    }

    const bcCat = document.getElementById('breadcrumb-cat');
    if (bcCat) bcCat.textContent = state.filterLabel;

    applySortAndFilter();
  };

  window.filterProducts = function () {
    const inp = document.getElementById('catalogSearch');
    state.searchQuery = inp ? String(inp.value || '').trim().toLowerCase() : '';
    state.visibleCount = 12;
    applySortAndFilter();
  };

  window.loadMore = function () {
    state.visibleCount += 12;
    renderProductsGrid();
  };

  window.applySortAndFilter = function () {
    const sortEl = document.getElementById('sortSelect');
    if (sortEl) state.sortBy = sortEl.value || 'relevancia';

    const hiddenCats = Array.isArray(state.config.hiddenCategories)
      ? state.config.hiddenCategories.map((c) => normalizeCategory(c))
      : [];

    let list = (Array.isArray(state.produtos) ? state.produtos : [])
      .map(normalizeProduct)
      .filter(Boolean)
      .filter((p) => !hiddenCats.includes(p.categoria));

    updateSubcategoryCounts(list);

    if (state.filterCat && state.filterCat !== 'all') {
      list = list.filter((p) => p.categoria === normalizeCategory(state.filterCat));
    }
    if (state.filterSub && state.filterSub !== 'all') {
      list = list.filter((p) => p.subcategoria === state.filterSub);
    }

    if (state.sortBy === 'novo') {
      list = list.filter((p) => p.badge === 'novo');
    } else if (state.sortBy === 'oferta') {
      list = list.filter((p) => p.badge === 'oferta' || parsePriceNum(p.priceOld) > p.preco);
    } else if (state.sortBy === 'vendido') {
      list = list.filter((p) => p.badge === 'vendido');
    } else if (state.sortBy === 'esgotado') {
      list = list.filter((p) => p.badge === 'esgotado');
    }

    if (state.searchQuery) {
      const q = state.searchQuery;
      list = list.filter(
        (p) =>
          p.nome.toLowerCase().includes(q) ||
          p.descricao.toLowerCase().includes(q) ||
          p.categoria.toLowerCase().includes(q)
      );
    }

    if (state.sortBy === 'preco_menor') {
      list.sort((a, b) => a.preco - b.preco);
    } else if (state.sortBy === 'preco_maior') {
      list.sort((a, b) => b.preco - a.preco);
    } else if (state.sortBy === 'desconto') {
      const disc = (item) => {
        const oldP = parsePriceNum(item.priceOld);
        return oldP > item.preco ? (oldP - item.preco) / oldP : 0;
      };
      list.sort((a, b) => disc(b) - disc(a));
    } else if (state.sortBy === 'mais_recentes') {
      list.sort((a, b) => Number(b.id) - Number(a.id) || String(b.created_at).localeCompare(String(a.created_at)));
    } else if (state.sortBy === 'nome_asc') {
      list.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    } else if (state.sortBy === 'nome_desc') {
      list.sort((a, b) => b.nome.localeCompare(a.nome, 'pt-BR'));
    }

    state.filtered = list;
    renderProductsGrid();
    renderAdminProdList();
  };

  function updateSubcategoryCounts(allVisibleProducts) {
    Object.keys(SUBCAT_LABELS).forEach((subKey) => {
      const el = document.getElementById(`cnt-${subKey}`);
      if (!el) return;
      const count = allVisibleProducts.filter((p) => p.subcategoria === subKey).length;
      el.textContent = count > 0 ? `(${count})` : '';
    });
  }

  function renderBadgeHtml(badge) {
    const map = {
      novo: { text: 'Novo', cls: 'badge-novo' },
      oferta: { text: 'Oferta', cls: 'badge-oferta' },
      vendido: { text: 'Mais Vendido', cls: 'badge-vendido' },
      esgotado: { text: 'Esgotado', cls: 'badge-esgotado' },
    };
    const info = map[badge];
    if (!info) return '';
    return `<span class="product-badge ${info.cls}">${info.text}</span>`;
  }

  function renderProductsGrid() {
    const grid = document.getElementById('productsGrid');
    const countEl = document.getElementById('resultCount');
    const loadMoreBtn = document.getElementById('loadMoreBtn');
    const noResults = document.getElementById('noResults');
    if (!grid) return;

    const total = state.filtered.length;
    if (countEl) {
      countEl.textContent = `${total} ${total === 1 ? 'produto' : 'produtos'}`;
    }

    if (total === 0) {
      grid.innerHTML = '';
      if (loadMoreBtn) loadMoreBtn.style.display = 'none';
      if (noResults) noResults.style.display = 'block';
      return;
    }

    if (noResults) noResults.style.display = 'none';
    const slice = state.filtered.slice(0, state.visibleCount);

    grid.innerHTML = slice
      .map((p) => {
        const imgSrc = p.imagem || 'favicon_io/android-chrome-512x512.png';
        const oldPriceNum = parsePriceNum(p.priceOld);
        const hasOld = oldPriceNum > p.preco;
        const subLabel = SUBCAT_LABELS[p.subcategoria] || (p.categoria === 'confeccao' ? 'Confecção' : p.categoria === 'kit' ? 'Kit' : 'Cosméticos');
        const safeId = escapeAttr(String(p.id));

        return `
          <article class="product-card" data-id="${safeId}" onclick="openProductModal('${safeId}')">
            <div class="product-img-wrap">
              ${renderBadgeHtml(p.badge)}
              <img class="product-img" src="${escapeAttr(imgSrc)}" alt="${escapeAttr(p.nome)}" loading="lazy" onerror="this.src='favicon_io/android-chrome-512x512.png'">
            </div>
            <div class="product-body">
              <span class="product-cat">${escapeHtml(subLabel)}</span>
              <h3 class="product-name">${escapeHtml(p.nome)}</h3>
              ${p.descricao ? `<p class="product-desc">${escapeHtml(p.descricao)}</p>` : ''}
              <div class="product-price-row">
                <span class="product-price">${formatBRL(p.preco)}</span>
                ${hasOld ? `<span class="product-price-old">${formatBRL(oldPriceNum)}</span>` : ''}
              </div>
              <div class="product-actions" onclick="event.stopPropagation()">
                <button type="button" class="btn-add-cart" onclick="addToCartById('${safeId}')">Adicionar</button>
                <button type="button" class="btn-details" onclick="openProductModal('${safeId}')">Detalhes</button>
              </div>
            </div>
          </article>
        `;
      })
      .join('');

    if (loadMoreBtn) {
      loadMoreBtn.style.display = total > state.visibleCount ? 'inline-block' : 'none';
    }
  }

  /* ── CARREGAMENTO DE PRODUTOS (API + STORAGE) ── */
  async function loadProducts() {
    let localList = [];
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.products) || '[]');
      if (Array.isArray(saved)) {
        localList = saved.map(normalizeProduct).filter(Boolean);
      }
    } catch (_) {}

    if (localList.length > 0) {
      state.produtos = localList;
      applySortAndFilter();
    }

    try {
      const res = await fetch(`${API_URL}/produtos`);
      if (res.ok) {
        const remoteList = await res.json();
        if (Array.isArray(remoteList)) {
          state.produtos = remoteList.map(normalizeProduct).filter(Boolean);
          saveAllToStorage();
          applySortAndFilter();
          return;
        }
      }
    } catch (err) {
      console.warn('Falha ao buscar produtos na API, mantendo cache local:', err);
    }

    if (!Array.isArray(state.produtos)) state.produtos = [];
    applySortAndFilter();
  }

  /* ── MODAL DE PRODUTO ── */
  window.openProductModal = function (id) {
    const prod = state.filtered.find((p) => String(p.id) === String(id)) ||
      state.produtos.map(normalizeProduct).find((p) => p && String(p.id) === String(id));
    if (!prod) return;

    state.activeProduct = prod;
    const imgs = prod.imagens && prod.imagens.length > 0
      ? prod.imagens
      : [prod.imagem || 'favicon_io/android-chrome-512x512.png'];
    state.activeImage = imgs[0];

    const overlay = document.getElementById('modalOverlay');
    const imgEl = document.getElementById('modalImg');
    const thumbsEl = document.getElementById('modalThumbs');
    const catEl = document.getElementById('modalCategory');
    const nameEl = document.getElementById('modalName');
    const descEl = document.getElementById('modalDesc');
    const priceEl = document.getElementById('modalPrice');
    const priceOldEl = document.getElementById('modalPriceOld');
    const wppEl = document.getElementById('modalWpp');
    const mpEl = document.getElementById('modalMp');

    if (imgEl) {
      imgEl.style.display = '';
      imgEl.src = state.activeImage;
      imgEl.alt = prod.nome;
    }

    if (thumbsEl) {
      thumbsEl.innerHTML = imgs
        .map(
          (u, idx) =>
            `<img src="${escapeAttr(u)}" class="modal-thumb ${idx === 0 ? 'active' : ''}" onclick="selectModalThumb('${escapeAttr(u)}', this)" onerror="this.style.display='none'">`
        )
        .join('');
    }

    if (catEl) catEl.textContent = SUBCAT_LABELS[prod.subcategoria] || prod.categoria;
    if (nameEl) nameEl.textContent = prod.nome;
    if (descEl) descEl.textContent = prod.descricao || 'Produto selecionado pela NIMARI.';
    if (priceEl) priceEl.textContent = formatBRL(prod.preco);

    const oldNum = parsePriceNum(prod.priceOld);
    if (priceOldEl) {
      if (oldNum > prod.preco) {
        priceOldEl.textContent = formatBRL(oldNum);
        priceOldEl.style.display = '';
      } else {
        priceOldEl.style.display = 'none';
      }
    }

    const phone = prod.wpp || state.config.wppNumber || DEFAULT_WPP;
    const msg = encodeURIComponent(`Olá! Tenho interesse no produto: ${prod.nome} (${formatBRL(prod.preco)}).`);
    if (wppEl) wppEl.href = `https://wa.me/${phone}?text=${msg}`;

    if (mpEl) {
      if (prod.mpLink) {
        mpEl.href = prod.mpLink;
        mpEl.style.display = 'inline-flex';
      } else {
        mpEl.style.display = 'none';
      }
    }

    if (overlay) {
      overlay.classList.add('open');
      overlay.style.display = 'flex';
    }
  };

  window.selectModalThumb = function (url, el) {
    state.activeImage = url;
    const imgEl = document.getElementById('modalImg');
    if (imgEl) imgEl.src = url;
    document.querySelectorAll('.modal-thumb').forEach((t) => t.classList.remove('active'));
    el?.classList.add('active');
  };

  window.closeModal = function () {
    const overlay = document.getElementById('modalOverlay');
    if (overlay) {
      overlay.classList.remove('open');
      overlay.style.display = 'none';
    }
  };

  window.closeModalOutside = function (ev) {
    if (ev.target && ev.target.id === 'modalOverlay') {
      window.closeModal();
    }
  };

  /* ── CARRINHO ── */
  window.toggleCart = function () {
    const drawer = document.getElementById('cartDrawer');
    const overlay = document.getElementById('cartOverlay');
    const isOpen = drawer?.classList.toggle('open');
    overlay?.classList.toggle('open', Boolean(isOpen));
  };

  window.addToCartById = function (id) {
    const prod = state.produtos.map(normalizeProduct).find((p) => p && String(p.id) === String(id));
    if (!prod) return;
    addItemToCart(prod);
  };

  window.addToCartFromModal = function () {
    if (!state.activeProduct) return;
    addItemToCart(state.activeProduct);
  };

  function addItemToCart(prod) {
    const existing = state.cart.find((item) => String(item.id) === String(prod.id));
    if (existing) {
      existing.qty += 1;
    } else {
      state.cart.push({
        id: prod.id,
        nome: prod.nome,
        preco: prod.preco,
        imagem: prod.imagem || 'favicon_io/android-chrome-512x512.png',
        qty: 1,
      });
    }
    saveAllToStorage();
    renderCart();
    showToast(`${prod.nome} adicionado ao carrinho!`);
  }

  window.changeCartQty = function (id, delta) {
    const idx = state.cart.findIndex((item) => String(item.id) === String(id));
    if (idx === -1) return;
    state.cart[idx].qty += delta;
    if (state.cart[idx].qty <= 0) state.cart.splice(idx, 1);
    saveAllToStorage();
    renderCart();
  };

  window.clearCart = function () {
    state.cart = [];
    saveAllToStorage();
    renderCart();
  };

  function renderCart() {
    const badge = document.getElementById('cartBadge');
    const subEl = document.getElementById('cartSubtitle');
    const emptyEl = document.getElementById('cartEmpty');
    const listEl = document.getElementById('cartList');
    const footerEl = document.getElementById('cartFooter');
    const subTotalEl = document.getElementById('cartSubtotal');
    const totalEl = document.getElementById('cartTotal');

    const totalQty = state.cart.reduce((acc, i) => acc + (i.qty || 1), 0);
    const totalPrice = state.cart.reduce((acc, i) => acc + parsePriceNum(i.preco) * (i.qty || 1), 0);

    if (badge) {
      badge.textContent = String(totalQty);
      badge.style.display = totalQty > 0 ? 'flex' : 'none';
    }
    if (subEl) {
      subEl.textContent = `${totalQty} ${totalQty === 1 ? 'item selecionado' : 'itens selecionados'}`;
    }

    if (totalQty === 0) {
      if (emptyEl) emptyEl.style.display = 'flex';
      if (listEl) listEl.innerHTML = '';
      if (footerEl) footerEl.style.display = 'none';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    if (footerEl) footerEl.style.display = 'block';

    if (listEl) {
      listEl.innerHTML = state.cart
        .map(
          (item) => `
          <li class="cart-item">
            <img src="${escapeAttr(item.imagem)}" alt="${escapeAttr(item.nome)}" class="cart-item-img" onerror="this.src='favicon_io/android-chrome-512x512.png'">
            <div class="cart-item-info">
              <p class="cart-item-name">${escapeHtml(item.nome)}</p>
              <p class="cart-item-price">${formatBRL(parsePriceNum(item.preco) * item.qty)}</p>
              <div class="cart-item-qty">
                <button type="button" onclick="changeCartQty('${escapeAttr(String(item.id))}', -1)">-</button>
                <span>${item.qty}</span>
                <button type="button" onclick="changeCartQty('${escapeAttr(String(item.id))}', 1)">+</button>
              </div>
            </div>
          </li>
        `
        )
        .join('');
    }

    if (subTotalEl) subTotalEl.textContent = formatBRL(totalPrice);
    if (totalEl) totalEl.textContent = formatBRL(totalPrice);
  }

  window.finalizeOrder = function () {
    const nameInp = document.getElementById('cartCustomerName');
    const addrInp = document.getElementById('cartCustomerAddress');
    const nome = nameInp ? nameInp.value.trim() : '';
    const end = addrInp ? addrInp.value.trim() : '';

    if (!nome) {
      showToast('Informe seu nome antes de enviar.');
      nameInp?.focus();
      return false;
    }
    if (!end) {
      showToast('Informe seu endereço para entrega.');
      addrInp?.focus();
      return false;
    }

    const lines = state.cart.map(
      (i) => `• ${i.qty}x ${i.nome} — ${formatBRL(parsePriceNum(i.preco) * i.qty)}`
    );
    const total = state.cart.reduce((acc, i) => acc + parsePriceNum(i.preco) * (i.qty || 1), 0);
    const text = [
      `Olá! Gostaria de fazer um pedido na *NIMARI*:`,
      ``,
      ...lines,
      ``,
      `*Total:* ${formatBRL(total)}`,
      `*Cliente:* ${nome}`,
      `*Endereço:* ${end}`,
    ].join('\n');

    const phone = state.config.wppNumber || DEFAULT_WPP;
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
    return false;
  };

  /* ── CONFIG, MARCAS, WHATSAPP, SOBRE E FAQ ── */
  function applyWppLinks() {
    const phone = state.config.wppNumber || DEFAULT_WPP;
    document.querySelectorAll('a[data-wpp-plain="1"]').forEach((a) => {
      a.href = `https://wa.me/${phone}?text=${encodeURIComponent('Olá! Vim pelo site da NIMARI!')}`;
    });
    document.querySelectorAll('a[data-wpp-msg]').forEach((a) => {
      const m = a.getAttribute('data-wpp-msg') || 'Olá! Vim pelo site da NIMARI!';
      a.href = `https://wa.me/${phone}?text=${encodeURIComponent(m)}`;
    });
  }

  function applyAboutImage() {
    const img = document.getElementById('aboutSectionImg');
    if (img && state.config.aboutImage) {
      img.style.display = '';
      img.src = state.config.aboutImage;
    }
  }

  function renderBrandsCarousel() {
    const track = document.getElementById('brandsTrack');
    if (!track || !Array.isArray(state.config.brands) || state.config.brands.length === 0) return;
    const items = [...state.config.brands, ...state.config.brands];
    track.innerHTML = items
      .map((b) => {
        const nome = escapeHtml(b.nome || 'Marca');
        const logoHtml = b.logo
          ? `<img class="brand-logo" src="${escapeAttr(b.logo)}" alt="${nome}" onerror="this.style.display='none'">`
          : '';
        return `<div class="brand-item">${logoHtml}<span class="brand-name">${nome}</span></div>`;
      })
      .join('');
  }

  function renderAdminBrandsList() {
    const wrap = document.getElementById('adminMarcasList');
    if (!wrap) return;
    const brands = Array.isArray(state.config.brands) ? state.config.brands : [];
    if (brands.length === 0) {
      wrap.innerHTML = '<p class="admin-list-hint">Nenhuma marca extra cadastrada.</p>';
      return;
    }
    wrap.innerHTML = brands
      .map(
        (b, idx) => `
        <div class="extra-img-row" style="margin-bottom:6px;">
          ${b.logo ? `<img class="extra-img-thumb" src="${escapeAttr(b.logo)}" alt="${escapeAttr(b.nome)}">` : ''}
          <span class="extra-img-url" style="color:#fff;font-size:.78rem;">${escapeHtml(b.nome)}</span>
          <button type="button" class="extra-img-del" onclick="removerMarca(${idx})" title="Remover marca">×</button>
        </div>
      `
      )
      .join('');
  }

  function renderConfigTab() {
    const inp = document.getElementById('configWppNumber');
    const prev = document.getElementById('configWppPreview');
    const wpp = state.config.wppNumber || DEFAULT_WPP;
    if (inp) inp.value = wpp;
    if (prev) prev.textContent = `Link ativo: https://wa.me/${wpp}`;

    const catWrap = document.getElementById('catVisibilityList');
    if (catWrap) {
      const cats = [
        { key: 'cosmeticos', label: 'Cosméticos' },
        { key: 'confeccao', label: 'Confecção' },
        { key: 'kit', label: 'Kit' },
      ];
      const hidden = Array.isArray(state.config.hiddenCategories) ? state.config.hiddenCategories : [];
      catWrap.innerHTML = cats
        .map((c) => {
          const checked = !hidden.includes(c.key);
          return `
            <label style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer;font-size:.85rem;">
              <input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleCategoryVisibility('${c.key}', this.checked)">
              <span>${c.label}</span>
            </label>
          `;
        })
        .join('');
    }
    renderAdminBrandsList();
  }

  function renderDepoList() {
    const wrap = document.getElementById('depoList');
    if (!wrap) return;
    const list = Array.isArray(state.depoimentos) ? state.depoimentos : [];
    if (list.length === 0) {
      wrap.innerHTML = '<p class="admin-list-hint">Nenhum depoimento cadastrado.</p>';
      return;
    }
    wrap.innerHTML = list
      .map(
        (d, i) => `
        <div class="admin-prod-item" onclick="openDepoForm(${i})">
          <div>
            <strong>${escapeHtml(d.autor || d.nome || 'Cliente')}</strong>
            <p class="admin-list-hint">${escapeHtml(d.mensagem || d.texto || '')}</p>
          </div>
          <span>★ ${escapeHtml(String(d.avaliacao || 5))}</span>
        </div>
      `
      )
      .join('');
  }

  window.toggleFaq = function (el) {
    const item = el?.closest('.faq-item');
    if (!item) return;
    const ans = item.querySelector('.faq-answer');
    const isOpen = item.classList.toggle('open');
    if (ans) ans.style.maxHeight = isOpen ? `${ans.scrollHeight}px` : '0px';
  };

  window.closeMobile = function () {
    document.getElementById('mobileMenu')?.classList.remove('open');
  };

  /* ── ADMIN PAINEL, EDIÇÃO, CRIAÇÃO E EXCLUSÃO ── */
  window.openAdminLogin = function () {
    const ov = document.getElementById('adminLoginOverlay');
    const err = document.getElementById('adminLoginErr');
    if (err) err.style.display = 'none';
    if (ov) {
      ov.style.display = 'flex';
      ov.classList.add('active', 'open', 'show');
    }
  };

  window.closeAdminLogin = function () {
    const ov = document.getElementById('adminLoginOverlay');
    const err = document.getElementById('adminLoginErr');
    if (err) err.style.display = 'none';
    if (ov) {
      ov.style.display = 'none';
      ov.classList.remove('active', 'open', 'show');
    }
  };

  window.adminLogin = async function () {
    const inp = document.getElementById('adminPwdInput');
    const err = document.getElementById('adminLoginErr');
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
      const resp = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.token) {
        if (err) {
          err.textContent = data.error || 'Senha incorreta. Tente novamente.';
          err.style.display = 'block';
        }
        return;
      }

      adminSessionToken = data.token;
      sessionStorage.setItem('nimari_admin_token', adminSessionToken);
      if (inp) inp.value = '';
      window.closeAdminLogin();
      openAdminPanel();
      showToast('Acesso administrativo liberado!');
    } catch (_) {
      if (err) {
        err.textContent = 'Erro de conexão com o servidor.';
        err.style.display = 'block';
      }
    }
  };

  function openAdminPanel() {
    const panel = document.getElementById('adminPanel');
    if (panel) {
      panel.style.display = 'block';
      panel.classList.add('open', 'active');
    }
    renderAdminProdList();
  }

  window.closeAdminPanel = function () {
    const panel = document.getElementById('adminPanel');
    if (panel) {
      panel.style.display = 'none';
      panel.classList.remove('open', 'active');
    }
  };

  window.adminLogout = function () {
    adminSessionToken = '';
    sessionStorage.removeItem('nimari_admin_token');
    window.closeAdminPanel();
  };

  window.switchTab = function (tabName) {
    document.querySelectorAll('.admin-tab').forEach((t, idx) => {
      const keys = ['edit', 'add', 'depo', 'config'];
      t.classList.toggle('active', keys[idx] === tabName);
    });
    document.querySelectorAll('.admin-tab-content').forEach((c) => {
      c.classList.toggle('active', c.id === `tab-${tabName}`);
    });
    if (tabName === 'edit') window.showAdminList();
    if (tabName === 'config') renderConfigTab();
  };

  window.showAdminList = function () {
    editingCard = null;
    const listWrap = document.getElementById('adminProdList');
    const formWrap = document.getElementById('adminEditForm');
    if (listWrap) listWrap.style.display = 'block';
    if (formWrap) formWrap.style.display = 'none';
    renderAdminProdList();
  };

  function renderAdminProdList() {
    const wrap = document.getElementById('adminProdListInner');
    if (!wrap) return;
    const list = (Array.isArray(state.produtos) ? state.produtos : []).map(normalizeProduct).filter(Boolean);
    if (list.length === 0) {
      wrap.innerHTML = '<p class="admin-list-hint">Nenhum produto cadastrado.</p>';
      return;
    }
    wrap.innerHTML = list
      .map(
        (p) => `
        <div class="admin-prod-item" onclick="editProductById('${escapeAttr(String(p.id))}')">
          <div style="display:flex;align-items:center;gap:10px;">
            <img src="${escapeAttr(p.imagem || 'favicon_io/android-chrome-512x512.png')}" alt="" style="width:38px;height:38px;object-fit:cover;border-radius:6px;" onerror="this.src='favicon_io/android-chrome-512x512.png'">
            <div>
              <strong style="display:block;font-size:.85rem;">${escapeHtml(p.nome)}</strong>
              <span style="font-size:.75rem;opacity:.75;">${formatBRL(p.preco)}</span>
            </div>
          </div>
          <span>Editar →</span>
        </div>
      `
      )
      .join('');
  }

  window.syncEditSubOptions = function (selectedSub) {
    const catEl = document.getElementById('editCat');
    const subEl = document.getElementById('editSub');
    if (!catEl || !subEl) return;
    const opts = CAT_SUBS[normalizeCategory(catEl.value)] || CAT_SUBS.cosmeticos;
    subEl.innerHTML = opts.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
    if (selectedSub) subEl.value = selectedSub;
  };

  window.editProductById = function (id) {
    const prod = state.produtos.map(normalizeProduct).find((p) => p && String(p.id) === String(id));
    if (!prod) return;
    editingCard = prod;
    editExtraImgs = Array.isArray(prod.imagens) ? [...prod.imagens] : [];
    currentBadge = prod.badge || 'none';

    const listWrap = document.getElementById('adminProdList');
    const formWrap = document.getElementById('adminEditForm');
    if (listWrap) listWrap.style.display = 'none';
    if (formWrap) formWrap.style.display = 'block';

    document.getElementById('editName').value = prod.nome;
    document.getElementById('editDesc').value = prod.descricao;
    document.getElementById('editPrice').value = prod.price;
    document.getElementById('editPriceOld').value = prod.priceOld || '';
    document.getElementById('editImgUrl').value = prod.imagem || '';
    document.getElementById('editCat').value = prod.categoria;
    window.syncEditSubOptions(prod.subcategoria);
    document.getElementById('editWpp').value = prod.wpp || '';
    document.getElementById('editMpLink').value = prod.mpLink || '';
    window.previewImageUrl('edit');
  };

  window.previewImageUrl = function (mode) {
    const urlInp = document.getElementById(`${mode}ImgUrl`);
    const prev = document.getElementById(`${mode}ImgPreview`);
    const ph = document.getElementById(`${mode}ImgPlaceholder`);
    const u = urlInp ? urlInp.value.trim() : '';
    if (prev && u) {
      prev.src = u;
      prev.style.display = 'block';
      if (ph) ph.style.display = 'none';
    } else if (prev) {
      prev.style.display = 'none';
      if (ph) ph.style.display = 'block';
    }
  };

  window.uploadImagem = async function (mode) {
    if (!assertAdminSession()) return;
    const fileInput = document.getElementById(`${mode}ImgFile`);
    const file = fileInput?.files?.[0];
    if (!file) return;

    const fd = new FormData();
    fd.append('file', file);
    fd.append('pasta', 'produtos');

    try {
      showToast('Enviando imagem...');
      const res = await adminFetch(`${API_URL}/upload`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || 'Falha no upload');
      const urlInp = document.getElementById(`${mode}ImgUrl`);
      if (urlInp) urlInp.value = data.url;
      window.previewImageUrl(mode);
      showToast('Imagem enviada com sucesso!');
    } catch (err) {
      showToast(`Erro: ${err.message}`);
    }
  };

  window.addNewProduct = async function () {
    if (!assertAdminSession()) return;
    const nome = document.getElementById('addName')?.value.trim() || '';
    const descricao = document.getElementById('addDesc')?.value.trim() || '';
    const preco = document.getElementById('addPrice')?.value.trim() || '';
    const priceOld = document.getElementById('addPriceOld')?.value.trim() || '';
    const categoria = document.getElementById('addCat')?.value || 'cosmeticos';
    const subcategoria = document.getElementById('addSub')?.value || '';
    const wpp = sanitizeDigits(document.getElementById('addWpp')?.value || '');
    const mpLink = document.getElementById('addMpLink')?.value.trim() || '';
    const imagem = document.getElementById('addImgUrl')?.value.trim() || '';

    if (!nome) {
      showToast('Informe o nome do produto.');
      return;
    }

    const payload = {
      nome,
      name: nome,
      preco,
      price: preco,
      priceOld,
      categoria,
      subcategoria,
      descricao,
      wpp,
      mpLink,
      badge: addBadge,
      imagem,
      imagens: imagem ? [imagem, ...addExtraImgs.filter((x) => x !== imagem)] : [...addExtraImgs],
    };

    try {
      const res = await adminFetch(`${API_URL}/produtos`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const created = await res.json();
      if (!res.ok) throw new Error(created.detail || created.error || 'Erro ao salvar');

      const norm = normalizeProduct(created);
      state.produtos.push(norm);
      saveAllToStorage();
      applySortAndFilter();
      showToast('Produto adicionado com sucesso!');
    } catch (err) {
      showToast(`Erro: ${err.message}`);
    }
  };

  window.saveProductEdits = function () {
    if (!editingCard) return;
    const idx = state.produtos.findIndex((p) => String(p.id) === String(editingCard.id));
    if (idx === -1) return;

    const nome = document.getElementById('editName')?.value.trim() || editingCard.nome;
    const precoRaw = document.getElementById('editPrice')?.value.trim() || editingCard.price;
    const imagem = document.getElementById('editImgUrl')?.value.trim() || '';

    state.produtos[idx] = normalizeProduct({
      ...state.produtos[idx],
      nome,
      name: nome,
      descricao: document.getElementById('editDesc')?.value.trim() || '',
      preco: parsePriceNum(precoRaw),
      price: precoRaw,
      priceOld: document.getElementById('editPriceOld')?.value.trim() || '',
      categoria: document.getElementById('editCat')?.value || 'cosmeticos',
      subcategoria: document.getElementById('editSub')?.value || '',
      wpp: sanitizeDigits(document.getElementById('editWpp')?.value || ''),
      mpLink: document.getElementById('editMpLink')?.value.trim() || '',
      badge: currentBadge,
      imagem,
      imagens: imagem ? [imagem, ...editExtraImgs.filter((x) => x !== imagem)] : [...editExtraImgs],
    });

    saveAllToStorage();
    applySortAndFilter();
    showToast('Produto atualizado com sucesso!');
  };

  window.deleteProduct = function () {
    if (!editingCard) return;
    state.produtos = state.produtos.filter((p) => String(p.id) !== String(editingCard.id));
    saveAllToStorage();
    applySortAndFilter();
    window.showAdminList();
    showToast('Produto removido.');
  };

  window.toggleCategoryVisibility = async function (catKey, isVisible) {
    if (!assertAdminSession()) return;
    if (isVisible) {
      state.config.hiddenCategories = state.config.hiddenCategories.filter((k) => k !== catKey);
    } else if (!state.config.hiddenCategories.includes(catKey)) {
      state.config.hiddenCategories.push(catKey);
    }
    saveAllToStorage();
    applySortAndFilter();
    showToast('Visibilidade atualizada!');
  };

  window.saveWppConfig = async function () {
    if (!assertAdminSession()) return;
    const inp = document.getElementById('configWppNumber');
    const digits = sanitizeDigits(inp?.value || '');
    if (!digits) {
      showToast('Informe um número válido.');
      return;
    }
    state.config.wppNumber = digits;
    saveAllToStorage();
    applyWppLinks();
    renderConfigTab();
    showToast('WhatsApp atualizado!');
  };

  window.previewAboutImage = function () {
    const file = document.getElementById('aboutImgFile')?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      pendingAboutImage = String(e.target?.result || '');
      const prev = document.getElementById('aboutImgPreview');
      const ph = document.getElementById('aboutImgPlaceholder');
      if (prev && pendingAboutImage) {
        prev.src = pendingAboutImage;
        prev.style.display = 'block';
        if (ph) ph.style.display = 'none';
      }
    };
    reader.readAsDataURL(file);
  };

  window.saveAboutImage = function () {
    if (!assertAdminSession() || !pendingAboutImage) return;
    state.config.aboutImage = pendingAboutImage;
    saveAllToStorage();
    applyAboutImage();
    showToast('Imagem da seção Sobre salva!');
  };

  window.adicionarMarca = function () {
    if (!assertAdminSession()) return;
    const nome = document.getElementById('novaMarcaNome')?.value.trim() || '';
    const logo = document.getElementById('novaMarcaLogo')?.value.trim() || '';
    if (!nome) return;
    if (!Array.isArray(state.config.brands)) state.config.brands = [];
    state.config.brands.push({ nome, logo });
    document.getElementById('novaMarcaNome').value = '';
    document.getElementById('novaMarcaLogo').value = '';
    saveAllToStorage();
    renderBrandsCarousel();
    renderAdminBrandsList();
    showToast('Marca adicionada!');
  };

  window.removerMarca = function (index) {
    if (!assertAdminSession()) return;
    state.config.brands?.splice(index, 1);
    saveAllToStorage();
    renderBrandsCarousel();
    renderAdminBrandsList();
    showToast('Marca removida.');
  };

  window.excluirTodosProdutos = function () {
    if (!assertAdminSession()) return;
    state.produtos = [];
    saveAllToStorage();
    applySortAndFilter();
    showToast('Todos os produtos foram removidos.');
  };

  /* ── INICIALIZAÇÃO ── */
  async function loadSavedConfig() {
    try {
      const savedCfg = JSON.parse(localStorage.getItem(STORAGE_KEYS.config) || 'null');
      if (savedCfg && typeof savedCfg === 'object') {
        state.config = {
          ...state.config,
          ...savedCfg,
          wppNumber: sanitizeDigits(savedCfg.wppNumber || DEFAULT_WPP) || DEFAULT_WPP,
        };
      }
      const savedCart = JSON.parse(localStorage.getItem(STORAGE_KEYS.cart) || '[]');
      if (Array.isArray(savedCart)) state.cart = savedCart;

      const savedDepos = JSON.parse(localStorage.getItem(STORAGE_KEYS.depoimentos) || '[]');
      if (Array.isArray(savedDepos)) state.depoimentos = savedDepos;
    } catch (_) {}

    try {
      const [cfgRes, depoRes] = await Promise.all([
        fetch(`${API_URL}/config`),
        fetch(`${API_URL}/depoimentos`),
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
            brands: Array.isArray(remoteCfg.brands) ? remoteCfg.brands : state.config.brands,
          };
        }
      }
      if (depoRes.ok) {
        const remoteDepos = await depoRes.json();
        if (Array.isArray(remoteDepos)) state.depoimentos = remoteDepos;
      }
      saveAllToStorage();
    } catch (_) {}

    applyWppLinks();
    applyAboutImage();
    renderBrandsCarousel();
    renderCart();
    renderDepoList();
    renderConfigTab();
  }

  window.addEventListener('DOMContentLoaded', () => {
    const ham = document.getElementById('hamburger');
    const mob = document.getElementById('mobileMenu');
    if (ham && mob) {
      ham.addEventListener('click', () => mob.classList.toggle('open'));
    }

    document.querySelectorAll('#addBadgeSelector .badge-opt').forEach((opt) => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('#addBadgeSelector .badge-opt').forEach((o) => o.classList.remove('sel'));
        opt.classList.add('sel');
        addBadge = opt.dataset.val || 'none';
      });
    });

    document.querySelectorAll('#adminEditForm .badge-opt').forEach((opt) => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('#adminEditForm .badge-opt').forEach((o) => o.classList.remove('sel'));
        opt.classList.add('sel');
        currentBadge = opt.dataset.val || 'none';
      });
    });

    loadSavedConfig().then(loadProducts);
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
              <option value="confeccao">Moda Íntima</option>
              <option value="kit">Kit</option>
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
              name: nome,
              preco,
              price: preco,
              categoria,
              descricao,
              imagem: imagemUrl,
              imagens: imagemUrl ? [imagemUrl] : [],
            }),
          });
          const prodData = await prodRes.json();
          if (!prodRes.ok) {
            throw new Error(prodData.detail || prodData.error || 'Falha ao cadastrar produto.');
          }

          statusEl.textContent = `Produto cadastrado com sucesso! ID: ${prodData.id}`;
          if (typeof window.applySortAndFilter === 'function') {
            if (Array.isArray(window.state?.produtos)) {
              window.state.produtos.push(prodData);
            }
            window.applySortAndFilter();
          }
        } catch (err) {
          statusEl.textContent = `Erro: ${err.message}`;
        }
      };
    }

    box.style.display = 'flex';
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