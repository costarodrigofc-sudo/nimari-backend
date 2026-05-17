require('dotenv').config();

// ── Imports
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const { createClient } = require('@supabase/supabase-js');

// ── Clientes
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const pool     = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
});

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

// ── Middlewares globais
app.use(cors());
app.use(express.json());
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname)));

// ── Middleware de autenticação
function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token ausente' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// ════════════════════════════════════
//  ROTA — UPLOAD DE IMAGEM
// ════════════════════════════════════

app.post('/api/upload', authMiddleware, upload.single('imagem'), async (req, res) => {
  try {
    const file = req.file;
    const ext  = file.originalname.split('.').pop();
    const nome = `Produtos/${Date.now()}.${ext}`;

    const { error } = await supabase.storage
      .from('Produtos')
      .upload(nome, file.buffer, { contentType: file.mimetype, upsert: true });

    if (error) return res.status(500).json({ error: error.message });

    const { data } = supabase.storage.from('Produtos').getPublicUrl(nome);
    res.json({ url: data.publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════
//  ROTAS — PRODUTOS
// ════════════════════════════════════

app.get('/api/produtos', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM produtos WHERE ativo = TRUE ORDER BY criado_em DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/produtos', authMiddleware, async (req, res) => {
  const { uid, name, descricao, price, price_old, img, badge, cat, sub, wpp } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO produtos (uid, name, descricao, price, price_old, img, badge, cat, sub, wpp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [uid, name, descricao, price, price_old, img, badge || 'none', cat, sub, wpp]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/produtos/:uid', authMiddleware, async (req, res) => {
  const { name, descricao, price, price_old, img, badge, cat, sub, wpp } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE produtos
       SET name=$1, descricao=$2, price=$3, price_old=$4, img=$5,
           badge=$6, cat=$7, sub=$8, wpp=$9, updated_at=NOW()
       WHERE uid=$10 RETURNING *`,
      [name, descricao, price, price_old, img, badge, cat, sub, wpp, req.params.uid]
    );
    res.json(rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/produtos/:uid', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE produtos SET ativo=FALSE WHERE uid=$1', [req.params.uid]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════
//  ROTAS — DEPOIMENTOS
// ════════════════════════════════════

app.get('/api/depoimentos', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM depoimentos WHERE ativo = TRUE ORDER BY criado_em DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/depoimentos', authMiddleware, async (req, res) => {
  const { nome, texto, estrelas, local, data, avatar } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO depoimentos (nome, texto, estrelas, local, data, avatar)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [nome, texto, estrelas || 5, local, data, avatar]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/depoimentos/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE depoimentos SET ativo=FALSE WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════
//  ROTAS — MARCAS
// ════════════════════════════════════

app.get('/api/marcas', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM marcas WHERE ativo = TRUE ORDER BY ordem ASC'
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/marcas', authMiddleware, async (req, res) => {
  const { nome, logo_url, ordem } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO marcas (nome, logo_url, ordem) VALUES ($1,$2,$3) RETURNING *`,
      [nome, logo_url, ordem || 0]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/marcas/:id', authMiddleware, async (req, res) => {
  const { nome, logo_url, ordem } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE marcas SET nome=$1, logo_url=$2, ordem=$3 WHERE id=$4 RETURNING *`,
      [nome, logo_url, ordem, req.params.id]
    );
    res.json(rows[0] || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/marcas/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE marcas SET ativo=FALSE WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════
//  ROTAS — CONFIGURAÇÕES
// ════════════════════════════════════

app.get('/api/config/:chave', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT valor FROM configuracoes WHERE chave=$1',
      [req.params.chave]
    );
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function upsertConfig(chave, valor, res) {
  try {
    await pool.query(
      `INSERT INTO configuracoes (chave, valor) VALUES ($1,$2)
       ON CONFLICT (chave) DO UPDATE SET valor=$2, updated_at=NOW()`,
      [chave, valor]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.put('/api/config/:chave', authMiddleware, (req, res) => {
  upsertConfig(req.params.chave, req.body.valor, res);
});

app.post('/api/config/:chave', authMiddleware, (req, res) => {
  const valor = req.body.valor ?? req.body.value;
  upsertConfig(req.params.chave, valor, res);
});

// ════════════════════════════════════
//  ROTAS — AUTENTICAÇÃO
// ════════════════════════════════════

app.post('/api/admin/criar', async (req, res) => {
  const { username, password } = req.body;
  try {
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      'INSERT INTO admin_users (username, password_hash) VALUES ($1,$2)',
      [username, hash]
    );
    res.json({ ok: true, mensagem: 'Admin criado com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reset-senha', async (req, res) => {
  const { username, password } = req.body;
  try {
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      'UPDATE admin_users SET password_hash=$1 WHERE username=$2',
      [hash, username]
    );
    res.json({ ok: true, mensagem: 'Senha atualizada com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM admin_users WHERE username=$1',
      [username]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Usuário não encontrado' });

    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Senha incorreta' });

    const token = jwt.sign(
      { id: rows[0].id, username: rows[0].username },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════
//  INICIAR SERVIDOR
// ════════════════════════════════════


// ════════════════════════════════════
//  ROTAS — MERCADO PAGO (Checkout Pro)
// ════════════════════════════════════
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// Cria preferência de pagamento e retorna o link do Checkout Pro
app.post('/api/checkout', async (req, res) => {
  const { items, customerName, customerAddress, wppNumber } = req.body;

  if (!items || !items.length) {
    return res.status(400).json({ error: 'Carrinho vazio.' });
  }

  try {
    const preference = new Preference(mpClient);

    const orderNum = 'NIM-' + Date.now().toString().slice(-8);

    const body = {
      external_reference: orderNum,
      items: items.map(item => ({
        id:          item.uid   || String(Math.random()),
        title:       item.name,
        description: (item.desc || '').substring(0, 256),
        picture_url: item.img   || '',
        quantity:    item.qty,
        unit_price:  parseFloat(item.priceRaw) || 0,
        currency_id: 'BRL',
      })),
      payer: {
        name: customerName || '',
      },
      metadata: {
        customerName,
        customerAddress,
        wppNumber,
        orderNum,
      },
      back_urls: {
        success: (process.env.SITE_URL || 'http://localhost:3001') + '/pagamento/sucesso',
        failure: (process.env.SITE_URL || 'http://localhost:3001') + '/pagamento/falha',
        pending: (process.env.SITE_URL || 'http://localhost:3001') + '/pagamento/pendente',
      },
      auto_return: 'approved',
      notification_url: (process.env.SITE_URL || 'http://localhost:3001') + '/api/webhook/mp',
      statement_descriptor: 'NIMARI',
    };

    const result = await preference.create({ body });
    res.json({
      id:         result.id,
      init_point: result.init_point,       // produção
      sandbox_url: result.sandbox_init_point, // testes
      orderNum,
    });
  } catch (err) {
    console.error('MP Checkout erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Webhook — notificações do Mercado Pago
app.post('/api/webhook/mp', async (req, res) => {
  res.sendStatus(200); // responde rápido para o MP não retentar

  const { type, data } = req.body;
  if (type !== 'payment' || !data?.id) return;

  try {
    const paymentClient = new Payment(mpClient);
    const payment = await paymentClient.get({ id: data.id });

    if (payment.status !== 'approved') return;

    const meta       = payment.metadata || {};
    const orderNum   = meta.order_num   || payment.external_reference || '';
    const customerName    = meta.customer_name    || '';
    const customerAddress = meta.customer_address || '';
    const wppNumber  = (meta.wpp_number || process.env.DEFAULT_WPP || '').replace(/\D/g, '');
    const total      = payment.transaction_amount || 0;

    console.log(`✅ Pagamento aprovado — Pedido ${orderNum} | Cliente: ${customerName} | R$ ${total}`);

    // Salva o pedido aprovado no banco (tabela opcional — crie se quiser histórico)
    try {
      await pool.query(
        `INSERT INTO pedidos (order_num, customer_name, customer_address, total, mp_payment_id, status)
         VALUES ($1,$2,$3,$4,$5,'approved')
         ON CONFLICT (order_num) DO UPDATE SET status='approved', mp_payment_id=$5`,
        [orderNum, customerName, customerAddress, total, String(data.id)]
      );
    } catch(dbErr) {
      // tabela pode não existir — só loga, não quebra
      console.warn('Tabela pedidos não encontrada (opcional):', dbErr.message);
    }

  } catch (err) {
    console.error('Webhook MP erro:', err.message);
  }
});

// Páginas de retorno após pagamento
app.get('/pagamento/sucesso',  (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/pagamento/falha',    (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/pagamento/pendente', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Servidor NIMARI rodando em http://localhost:${PORT}`);
});
