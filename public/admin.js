(function () {
  const API = (window.NIMARI_API_URL || '/api').replace(/\/$/, '');
  const FALLBACK_IMG = 'favicon_io/android-chrome-512x512.png';

  const SUBS = {
    cosmeticos: [
      ['pele', 'Cuidados com a Pele'], ['cabelo', 'Cuidados com o Cabelo'],
      ['perf-fem', 'Perfumaria Feminina'], ['perf-masc', 'Perfumaria Masculina'],
      ['infantil-cosm', 'Infantil'], ['outros-cosm', 'Outros'],
    ],
    confeccao: [
      ['intima-fem', 'Moda Íntima Feminina'], ['moda-fem', 'Moda Feminina'], ['intima-inf', 'Moda Íntima Infantil'],
      ['sutia', 'Sutiã'], ['calcinha', 'Calcinha'], ['outros-conf', 'Outros'],
    ],
    kit: [['kit-presente', 'Kit Presente']],
  };
  const BADGES = [['none', 'Sem selo'], ['novo', 'Novo'], ['oferta', 'Oferta'], ['vendido', 'Mais vendido'], ['esgotado', 'Esgotado']];
  const CAT_LABEL = { cosmeticos: 'Cosméticos', confeccao: 'Confecção', kit: 'Kit' };

  let produtos = [];
  let editId = null;
  let imagens = [];
  let loteItens = [];

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const getToken = () => sessionStorage.getItem('nimari_admin_token') || '';
  const brl = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const numToInput = (v) => (v === null || v === undefined || v === '' ? '' : String(Number(v)).replace('.', ','));

  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('err', Boolean(isErr));
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 3000);
  }

  async function api(path, opts = {}) {
    const headers = new Headers(opts.headers || {});
    const tk = getToken();
    if (tk) headers.set('Authorization', `Bearer ${tk}`);
    if (!(opts.body instanceof FormData) && opts.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const res = await fetch(`${API}${path}`, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && getToken()) {
      sairAdmin();
      $('loginErr').textContent = 'Sessão expirada. Entre novamente.';
      throw new Error('Sessão expirada.');
    }
    if (!res.ok) throw new Error(data.detail || data.error || `Erro ${res.status}`);
    return data;
  }

  /* ── AUTENTICAÇÃO ── */
  function atualizarTela() {
    const logado = Boolean(getToken());
    $('loginBox').classList.toggle('hidden', logado);
    $('panelBox').classList.toggle('hidden', !logado);
    $('btnSair').classList.toggle('hidden', !logado);
    if (logado) carregarProdutos();
  }

  window.fazerLogin = async function () {
    const err = $('loginErr');
    const pwd = $('pwdInput').value.trim();
    err.textContent = '';
    if (!pwd) { err.textContent = 'Digite a senha.'; return; }
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) { err.textContent = data.error || 'Senha inválida.'; return; }
      sessionStorage.setItem('nimari_admin_token', data.token);
      $('pwdInput').value = '';
      atualizarTela();
    } catch {
      err.textContent = 'Erro de conexão com o servidor.';
    }
  };

  window.sairAdmin = function () {
    sessionStorage.removeItem('nimari_admin_token');
    atualizarTela();
  };

  /* ── ABAS ── */
  window.trocarAba = function (aba) {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === aba));
    ['lista', 'form', 'lote'].forEach((k) => $(`aba-${k}`).classList.toggle('hidden', k !== aba));
  };

  /* ── LISTA ── */
  window.carregarProdutos = async function () {
    try {
      produtos = await api('/produtos?all=1');
      if (!Array.isArray(produtos)) produtos = [];
      renderLista();
    } catch (e) {
      $('lista').innerHTML = `<p class="msg">Erro ao carregar: ${esc(e.message)}</p>`;
    }
  };

  window.renderLista = function () {
    const q = $('busca').value.trim().toLowerCase();
    const st = $('filtroStatus').value;
    const lista = produtos.filter((p) => {
      if (st === 'ativos' && !p.ativo) return false;
      if (st === 'inativos' && p.ativo) return false;
      if (!q) return true;
      return [p.nome, p.sku, p.categoria, p.marca].some((v) => String(v || '').toLowerCase().includes(q));
    });
    $('contagem').textContent = `${lista.length} de ${produtos.length} produto(s)`;
    if (!lista.length) { $('lista').innerHTML = '<p class="hint" style="padding:14px 6px;">Nenhum produto encontrado.</p>'; return; }

    $('lista').innerHTML = lista.map((p) => {
      const img = p.imagem || FALLBACK_IMG;
      const selo = p.badge && p.badge !== 'none' ? `<span class="pill">${esc(p.badge)}</span>` : '';
      return `
        <div class="row ${p.ativo ? '' : 'inativo'}">
          <img src="${esc(img)}" alt="" onerror="this.onerror=null;this.src='${FALLBACK_IMG}'">
          <div class="info">
            <strong>${esc(p.nome)}${selo}<span class="pill ${p.ativo ? 'on' : ''}">${p.ativo ? 'ativo' : 'inativo'}</span></strong>
            <span>#${p.id} · ${esc(p.sku)} · ${esc(CAT_LABEL[p.categoria] || p.categoria)} · ${brl(p.preco)}</span>
          </div>
          <div class="acts" style="display:flex;gap:8px;">
            <button type="button" class="btn sec sm" onclick="alternarAtivo(${p.id})">${p.ativo ? 'Desativar' : 'Ativar'}</button>
            <button type="button" class="btn sm" onclick="editarProduto(${p.id})">Editar</button>
          </div>
        </div>`;
    }).join('');
  };

  window.alternarAtivo = async function (id) {
    const p = produtos.find((x) => x.id === id);
    if (!p) return;
    try {
      await api(`/produtos/${id}`, { method: 'PATCH', body: JSON.stringify({ ativo: !p.ativo }) });
      toast(p.ativo ? 'Produto desativado.' : 'Produto ativado.');
      await carregarProdutos();
    } catch (e) { toast(e.message, true); }
  };

  /* ── FORMULÁRIO ── */
  function preencherSelects() {
    $('f-badge').innerHTML = BADGES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    syncSubs();
  }

  window.syncSubs = function (selecionada) {
    const cat = $('f-cat').value;
    $('f-sub').innerHTML =
      '<option value="">(nenhuma)</option>' +
      (SUBS[cat] || []).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    if (typeof selecionada === 'string') $('f-sub').value = selecionada;
  };

  function limparForm() {
    editId = null;
    imagens = [];
    ['f-nome', 'f-preco', 'f-antigo', 'f-marca', 'f-desc', 'f-wpp', 'f-mp'].forEach((id) => ($(id).value = ''));
    $('f-cat').value = 'cosmeticos';
    syncSubs('');
    $('f-badge').value = 'none';
    $('f-ativo').checked = true;
    $('f-files').value = '';
    $('formMsg').textContent = '';
    renderImagens();
  }

  window.novoProduto = function () {
    limparForm();
    $('formTitulo').textContent = 'Novo produto';
    $('tabForm').textContent = 'Novo produto';
    $('btnExcluir').classList.add('hidden');
    trocarAba('form');
  };

  window.editarProduto = function (id) {
    const p = produtos.find((x) => x.id === id);
    if (!p) return;
    limparForm();
    editId = p.id;
    $('f-nome').value = p.nome || '';
    $('f-preco').value = numToInput(p.preco);
    $('f-antigo').value = numToInput(p.preco_antigo);
    $('f-cat').value = p.categoria || 'cosmeticos';
    syncSubs(p.subcategoria || '');
    $('f-badge').value = p.badge || 'none';
    $('f-marca').value = p.marca || '';
    $('f-desc').value = p.descricao || '';
    $('f-wpp').value = p.wpp || '';
    $('f-mp').value = p.mp_link || '';
    $('f-ativo').checked = p.ativo !== false;
    imagens = Array.isArray(p.imagens) && p.imagens.length ? [...p.imagens] : p.imagem ? [p.imagem] : [];
    renderImagens();
    $('formTitulo').textContent = `Editando #${p.id} · ${p.sku}`;
    $('tabForm').textContent = 'Editando produto';
    $('btnExcluir').classList.remove('hidden');
    trocarAba('form');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  function renderImagens() {
    $('imgs').innerHTML = imagens.map((u, i) => `
      <div class="img-item ${i === 0 ? 'main' : ''}">
        ${i === 0 ? '<span class="tag-main">Principal</span>' : ''}
        <img src="${esc(u)}" alt="" onerror="this.onerror=null;this.src='${FALLBACK_IMG}'">
        <div class="bar">
          <button type="button" title="Tornar principal" onclick="imgPrincipal(${i})">★</button>
          <button type="button" title="Remover" onclick="imgRemover(${i})">✕</button>
        </div>
      </div>`).join('');
  }
  window.imgPrincipal = function (i) {
    const [u] = imagens.splice(i, 1);
    imagens.unshift(u);
    renderImagens();
  };
  window.imgRemover = function (i) {
    imagens.splice(i, 1);
    renderImagens();
  };

  window.enviarImagens = async function (input) {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    const msg = $('formMsg');
    msg.className = 'msg';
    let ok = 0;
    for (let i = 0; i < files.length; i += 1) {
      msg.textContent = `Enviando imagem ${i + 1} de ${files.length}...`;
      try {
        const fd = new FormData();
        fd.append('file', files[i]);
        fd.append('pasta', 'produtos');
        const data = await api('/upload', { method: 'POST', body: fd });
        if (data.url) { imagens.push(data.url); ok += 1; }
      } catch (e) {
        msg.textContent = `Falha na imagem ${i + 1}: ${e.message}`;
        toast(e.message, true);
      }
    }
    input.value = '';
    renderImagens();
    if (ok) { msg.className = 'msg ok'; msg.textContent = `${ok} imagem(ns) enviada(s). Lembre de salvar o produto.`; }
  };

  window.salvarProduto = async function () {
    const msg = $('formMsg');
    msg.className = 'msg';
    msg.textContent = '';
    const nome = $('f-nome').value.trim();
    if (!nome) { msg.textContent = 'Informe o nome do produto.'; $('f-nome').focus(); return; }
    if (!$('f-preco').value.trim()) { msg.textContent = 'Informe o preço.'; $('f-preco').focus(); return; }

    const payload = {
      nome,
      preco: $('f-preco').value.trim(),
      preco_antigo: $('f-antigo').value.trim(),
      categoria: $('f-cat').value,
      subcategoria: $('f-sub').value,
      badge: $('f-badge').value,
      marca: $('f-marca').value.trim(),
      descricao: $('f-desc').value.trim(),
      wpp: $('f-wpp').value.trim(),
      mp_link: $('f-mp').value.trim(),
      ativo: $('f-ativo').checked,
      imagem: imagens[0] || '',
      imagens: [...imagens],
    };

    const btn = $('btnSalvar');
    btn.disabled = true;
    try {
      if (editId) {
        await api(`/produtos/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast('Produto atualizado!');
      } else {
        await api('/produtos', { method: 'POST', body: JSON.stringify(payload) });
        toast('Produto cadastrado!');
      }
      await carregarProdutos();
      trocarAba('lista');
    } catch (e) {
      msg.textContent = `Erro: ${e.message}`;
    } finally {
      btn.disabled = false;
    }
  };

  window.excluirProduto = async function () {
    if (!editId) return;
    const p = produtos.find((x) => x.id === editId);
    if (!confirm(`Excluir definitivamente "${p ? p.nome : '#' + editId}"?\n\nDica: use "Desativar" se quiser apenas esconder da vitrine.`)) return;
    try {
      await api(`/produtos/${editId}`, { method: 'DELETE' });
      toast('Produto excluído.');
      await carregarProdutos();
      trocarAba('lista');
    } catch (e) { $('formMsg').textContent = `Erro: ${e.message}`; }
  };

  /* ── IMPORTAÇÃO EM LOTE ── */
  window.baixarModelo = function () {
    if (!window.XLSX) return toast('Biblioteca de planilha não carregou.', true);
    const ws = XLSX.utils.json_to_sheet([
      { codigo: '', nome: 'Sabonete Líquido', preco: '39,90', preco_antigo: '49,90', categoria: 'cosmeticos', subcategoria: 'pele', descricao: 'Hidratação diária', imagem: '', selo: 'novo' },
      { codigo: '', nome: 'Conjunto Renda', preco: '89,90', preco_antigo: '', categoria: 'confeccao', subcategoria: 'intima-fem', descricao: 'Conforto e elegância', imagem: '', selo: '' },
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Produtos');
    XLSX.writeFile(wb, 'modelo_produtos_nimari.xlsx');
  };

  window.lerArquivoLote = function (file) {
    if (!file) return;
    if (!window.XLSX) return toast('Biblioteca de planilha não carregou.', true);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        loteItens = rows
          .map((r) => ({
            sku: String(r.codigo || r.sku || '').trim(),
            nome: String(r.nome || r.name || '').trim(),
            preco: r.preco !== '' ? r.preco : r.price ?? 0,
            preco_antigo: r.preco_antigo ?? r.priceOld ?? '',
            categoria: String(r.categoria || 'cosmeticos').trim(),
            subcategoria: String(r.subcategoria || '').trim(),
            descricao: String(r.descricao || '').trim(),
            imagem: String(r.imagem || '').trim(),
            badge: String(r.selo || r.badge || 'none').trim().toLowerCase() || 'none',
          }))
          .filter((x) => x.nome);
      } catch {
        loteItens = [];
        $('loteMsg').textContent = 'Não consegui ler esse arquivo.';
      }
      $('lotePreview').innerHTML = loteItens.length
        ? `<strong>${loteItens.length}</strong> produto(s) prontos para importar (mostrando 10):` +
          '<table><thead><tr><th>Nome</th><th>Preço</th><th>Categoria</th><th>Selo</th></tr></thead><tbody>' +
          loteItens.slice(0, 10).map((i) => `<tr><td>${esc(i.nome)}</td><td>${esc(i.preco)}</td><td>${esc(i.categoria)}</td><td>${esc(i.badge)}</td></tr>`).join('') +
          '</tbody></table>'
        : '<p class="hint">Nenhuma linha com nome encontrada.</p>';
      $('btnLote').classList.toggle('hidden', !loteItens.length);
    };
    reader.readAsArrayBuffer(file);
  };

  window.enviarLote = async function () {
    const msg = $('loteMsg');
    msg.className = 'msg';
    if (!loteItens.length) return;
    msg.textContent = 'Importando...';
    $('btnLote').disabled = true;
    try {
      const data = await api('/produtos/batch', { method: 'POST', body: JSON.stringify({ produtos: loteItens }) });
      msg.className = 'msg ok';
      msg.textContent = `Concluído: ${data.criados} novo(s) e ${data.atualizados} atualizado(s).`;
      loteItens = [];
      $('lotePreview').innerHTML = '';
      $('btnLote').classList.add('hidden');
      $('loteFile').value = '';
      await carregarProdutos();
    } catch (e) {
      msg.textContent = `Nada foi importado.\n${e.message}`;
    } finally {
      $('btnLote').disabled = false;
    }
  };

  window.addEventListener('DOMContentLoaded', () => {
    preencherSelects();
    atualizarTela();
  });
})();
