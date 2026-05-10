require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const express    = require('express');
const cors       = require('cors');
const { Pool }   = require('pg');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');

const app  = express();
const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
});

app.use(cors());
app.use(express.json());
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

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
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
const path = require('path');
app.use(express.static(path.join(__dirname, '../')));
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
//  ROTAS — PRODUTOS
// ════════════════════════════════════

// Listar todos os produtos ativos (público)
app.get('/api/produtos', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { rows } = await pool.query(
      'SELECT * FROM produtos WHERE ativo = TRUE ORDER BY criado_em DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Criar produto (protegido)
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

// Atualizar produto (protegido)
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

// Remover produto (protegido) — soft delete
app.delete('/api/produtos/:uid', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'UPDATE produtos SET ativo=FALSE WHERE uid=$1',
      [req.params.uid]
    );
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

app.put('/api/config/:chave', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO configuracoes (chave, valor) VALUES ($1,$2)
       ON CONFLICT (chave) DO UPDATE SET valor=$2, updated_at=NOW()`,
      [req.params.chave, req.body.valor]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════
//  ROTAS — AUTENTICAÇÃO
// ════════════════════════════════════

// Criar admin (rode UMA vez para cadastrar)
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
    await pool.query('UPDATE admin_users SET password_hash=$1 WHERE username=$2', [hash, username]);
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
const PORT = process.env.PORT || 3001;

app.get('/', (req, res) => {
  // Removido o '../' pois o arquivo está na mesma pasta que o server.js
  res.sendFile(path.join(__dirname, 'index.htm')); 
});

app.listen(PORT, () => {
  console.log(`✅ Servidor NIMARI rodando em http://localhost:${PORT}`);
});