(function () {
  const API = (window.NIMARI_API_URL || '/api').replace(/\/$/, '');
  const FALLBACK_IMG = 'favicon_io/android-chrome-512x512.png';
  let produtosCache = [];
  let editandoId = null;
  let loteItens = [];

  function getToken() {
    return sessionStorage.getItem('nimari_admin_token') || '';
  }

  function sanitizeUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/supabase\.co/i.test(u)) return '';
  return u;
}

  function formatBRL(val) {
    const num = Number(String(val ?? 0).replace(',', '.')) || 0;
    return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  async function authFetch(path, opts = {}) {
    const headers = new Headers(opts.headers || {});
    const tk = getToken();
    if (tk) headers.set('Authorization', `Bearer ${tk}`);
    if (!(opts.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(`${API}${path}`, { ...opts, headers });
  }

  function atualizarTelaAuth() {
    const logado = Boolean(getToken());
    document.getElementById('loginBox').style.display = logado ? 'none' : 'block';
    document.getElementById('panelBox').style.display = logado ? 'block' : 'none';
    if (logado) carregarProdutos();
  }

  window.fazerLogin = async function () {
    const pwd = document.getElementById('pwdInput').value.trim();
    const err = document.getElementById('loginErr');
    err.textContent = '';
    if (!pwd) {
      err.textContent = 'Digite a senha.';
      return;
    }
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
      err.textContent = data.error || 'Senha inválida.';
      return;
    }
    sessionStorage.setItem('nimari_admin_token', data.token);
    document.getElementById('pwdInput').value = '';
    atualizarTelaAuth();
  };

  window.sairAdmin = function () {
    sessionStorage.removeItem('nimari_admin_token');
    atualizarTelaAuth();
  };

  window.trocarAba = function (aba) {
    document.querySelectorAll('.adm-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === aba);
    });
    ['lista', 'novo', 'lote'].forEach((k) => {
      document.getElementById(`aba-${k}`).style.display = k === aba ? 'block' : 'none';
    });
  };

  window.carregarProdutos = async function () {
    const res = await fetch(`${API}/produtos`);
    const list = await res.json().catch(() => []);
    produtosCache = Array.isArray(list) ? list : [];
    renderListaProdutos();
  };

  window.renderListaProdutos = function () {
    const q = (document.getElementById('buscaAdmin')?.value || '').trim().toLowerCase();
    const wrap = document.getElementById('listaProdutos');
    const filtrados = produtosCache.filter((p) => {
      const nome = String(p.nome || p.name || '').toLowerCase();
      const cat = String(p.categoria || '').toLowerCase();
      return !q || nome.includes(q) || cat.includes(q);
    });

    if (filtrados.length === 0) {
      wrap.innerHTML = '<p style="opacity:.75;">Nenhum produto encontrado.</p>';
      return;
    }

    wrap.innerHTML = filtrados
      .map((p) => {
        const nome = p.nome || p.name || 'Produto';
        const preco = p.preco ?? p.price ?? 0;
        const img = sanitizeUrl(p.imagem) || FALLBACK_IMG;
        return `
          <div class="adm-row">
            <div style="display:flex;align-items:center;gap:12px;">
              <img src="${img}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:6px;" onerror="this.src='${FALLBACK_IMG}'">
              <div>
                <strong>#${p.id} · ${nome}</strong>
                <div style="font-size:.82rem;opacity:.75;">${p.categoria || 'cosmeticos'} · ${formatBRL(preco)}</div>
              </div>
            </div>
            <button type="button" class="adm-btn sec" onclick="abrirEdicao(${p.id})">Editar</button>
          </div>
        `;
      })
      .join('');
  };

  window.abrirEdicao = function (id) {
    const p = produtosCache.find((item) => Number(item.id) === Number(id));
    if (!p) return;
    editandoId = p.id;
    document.getElementById('editIdLabel').textContent = p.id;
    document.getElementById('editNome').value = p.nome || p.name || '';
    document.getElementById('editPreco').value = p.price || p.preco || '';
    document.getElementById('editCat').value = p.categoria || 'cosmeticos';
    document.getElementById('editImg').value = sanitizeUrl(p.imagem);
    document.getElementById('editDesc').value = p.descricao || '';
    document.getElementById('formEdicao').style.display = 'block';
  };

  window.fecharEdicao = function () {
    editandoId = null;
    document.getElementById('formEdicao').style.display = 'none';
  };

  window.salvarEdicao = async function () {
    if (!editandoId) return;
    const payload = {
      nome: document.getElementById('editNome').value.trim(),
      preco: document.getElementById('editPreco').value.trim(),
      categoria: document.getElementById('editCat').value,
      imagem: sanitizeUrl(document.getElementById('editImg').value.trim()),
      descricao: document.getElementById('editDesc').value.trim(),
    };
    const res = await authFetch(`/produtos/${editandoId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      fecharEdicao();
      await carregarProdutos();
    }
  };

  window.excluirProdutoAtual = async function () {
    if (!editandoId) return;
    const res = await authFetch(`/produtos/${editandoId}`, { method: 'DELETE' });
    if (res.ok) {
      fecharEdicao();
      await carregarProdutos();
    }
  };

  window.cadastrarIndividual = async function () {
    const st = document.getElementById('novoStatus');
    const nome = document.getElementById('novoNome').value.trim();
    const preco = document.getElementById('novoPreco').value.trim();
    const categoria = document.getElementById('novoCat').value;
    const descricao = document.getElementById('novoDesc').value.trim();
    const file = document.getElementById('novoFile').files[0];

    if (!nome) {
      st.textContent = 'Informe o nome do produto.';
      return;
    }

    try {
      let imagem = '';
      if (file) {
        st.textContent = 'Enviando imagem para o R2...';
        const fd = new FormData();
        fd.append('file', file);
        fd.append('pasta', 'produtos');
        const up = await authFetch('/upload', { method: 'POST', body: fd });
        const upData = await up.json();
        if (!up.ok || !upData.url) throw new Error(upData.error || 'Erro no upload.');
        imagem = upData.url;
      }

      st.textContent = 'Salvando produto...';
      const res = await authFetch('/produtos', {
        method: 'POST',
        body: JSON.stringify({ nome, preco, categoria, descricao, imagem, imagens: imagem ? [imagem] : [] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || 'Erro ao salvar.');

      document.getElementById('novoNome').value = '';
      document.getElementById('novoPreco').value = '';
      document.getElementById('novoDesc').value = '';
      document.getElementById('novoFile').value = '';
      st.textContent = `Cadastrado com sucesso (ID #${data.id}).`;
      await carregarProdutos();
    } catch (err) {
      st.textContent = `Erro: ${err.message}`;
    }
  };

  window.baixarModeloPlanilha = function () {
    if (!window.XLSX) return;
    const ws = XLSX.utils.json_to_sheet([
      { nome: 'Sabonete Líquido', preco: '39,90', categoria: 'cosmeticos', descricao: 'Hidratação diária', imagem: '' },
      { nome: 'Conjunto Renda', preco: '89,90', categoria: 'confeccao', descricao: 'Conforto e elegância', imagem: '' },
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Produtos');
    XLSX.writeFile(wb, 'modelo_produtos_nimari.xlsx');
  };

  window.lerArquivoLote = function (file) {
    if (!file || !window.XLSX) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet);
      loteItens = rows
        .map((r) => ({
          nome: String(r.nome || r.name || '').trim(),
          preco: r.preco ?? r.price ?? 0,
          categoria: String(r.categoria || 'cosmeticos').trim() || 'cosmeticos',
          descricao: String(r.descricao || '').trim(),
          imagem: sanitizeUrl(r.imagem || ''),
        }))
        .filter((x) => x.nome);

      document.getElementById('lotePreview').innerHTML =
        `<strong>${loteItens.length}</strong> produto(s) pronto(s) para importar.` +
        (loteItens.length
          ? `<table><thead><tr><th>Nome</th><th>Preço</th><th>Categoria</th></tr></thead><tbody>` +
            loteItens.slice(0, 10).map((i) => `<tr><td>${i.nome}</td><td>${i.preco}</td><td>${i.categoria}</td></tr>`).join('') +
            `</tbody></table>`
          : '');
      document.getElementById('btnImportarLote').style.display = loteItens.length ? 'inline-block' : 'none';
    };
    reader.readAsArrayBuffer(file);
  };

  window.enviarLote = async function () {
    const st = document.getElementById('loteStatus');
    if (!loteItens.length) return;
    st.textContent = 'Importando lote...';
    const res = await authFetch('/produtos/batch', {
      method: 'POST',
      body: JSON.stringify({ produtos: loteItens }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      st.textContent = `Erro: ${data.detail || data.error || 'Falha no lote.'}`;
      return;
    }
    st.textContent = `${data.count} produto(s) importado(s) com sucesso!`;
    loteItens = [];
    document.getElementById('lotePreview').innerHTML = '';
    document.getElementById('btnImportarLote').style.display = 'none';
    await carregarProdutos();
  };

  window.addEventListener('DOMContentLoaded', atualizarTelaAuth);
})();