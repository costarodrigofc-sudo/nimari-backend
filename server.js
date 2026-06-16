require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const { createClient } = require('@supabase/supabase-js');

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

app.use(cors());
app.use(express.json());
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname)));

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

// UPLOAD
app.post('/api/upload', authMiddleware, upload.single('imagem'), async (req, res) => {
  try {
    const file = req.file;
    const ext  = file.originalname.split('.').pop();
    const nome = `Produtos/${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('Produtos').upload(nome, file.buffer, { contentType: file.mimetype, upsert: true });
    if (error) return res.status(500).json({ error: error.message });
    const { data } = supabase.storage.from('Produtos').getPublicUrl(nome);
    res.json({ url: data.publicUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PRODUTOS
app.get('/api/produtos', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM produtos WHERE ativo = TRUE ORDER BY criado_em DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/produtos', authMiddleware, async (req, res) => {
  const { uid, name, descricao, price, price_old, img, badge, cat, sub, wpp, imagens } = req.body;
  const imagensArr = Array.isArray(imagens) ? imagens : (imagens ? [imagens] : []);
  try {
    const { rows } = await pool.query(
      `INSERT INTO produtos (uid, name, descricao, price, price_old, img, badge, cat, sub, wpp, imagens) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [uid, name, descricao, price, price_old, img, badge || 'none', cat, sub, wpp, imagensArr]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/produtos/:uid', authMiddleware, async (req, res) => {
  const { name, descricao, price, price_old, img, badge, cat, sub, wpp, imagens } = req.body;
  const imagensArr = Array.isArray(imagens) ? imagens : (imagens ? [imagens] : []);
  try {
    const { rows } = await pool.query(
      `UPDATE produtos SET name=$1, descricao=$2, price=$3, price_old=$4, img=$5, badge=$6, cat=$7, sub=$8, wpp=$9, imagens=$10, updated_at=NOW() WHERE uid=$11 RETURNING *`,
      [name, descricao, price, price_old, img, badge, cat, sub, wpp, imagensArr, req.params.uid]
    );
    res.json(rows[0] || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/produtos/:uid', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE produtos SET ativo=FALSE WHERE uid=$1', [req.params.uid]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DEPOIMENTOS
app.get('/api/depoimentos', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM depoimentos WHERE ativo = TRUE ORDER BY criado_em DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/depoimentos', authMiddleware, async (req, res) => {
  const { nome, texto, estrelas, local, data, avatar } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO depoimentos (nome, texto, estrelas, local, data, avatar) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [nome, texto, estrelas || 5, local, data, avatar]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/depoimentos/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE depoimentos SET ativo=FALSE WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// MARCAS
app.get('/api/marcas', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM marcas WHERE ativo = TRUE ORDER BY ordem ASC');
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

// CONFIGURAÇÕES
app.get('/api/config/:chave', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT valor FROM configuracoes WHERE chave=$1', [req.params.chave]);
    res.json(rows[0] || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function upsertConfig(chave, valor, res) {
  try {
    await pool.query(
      `INSERT INTO configuracoes (chave, valor) VALUES ($1,$2) ON CONFLICT (chave) DO UPDATE SET valor=$2, updated_at=NOW()`,
      [chave, valor]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

app.put('/api/config/:chave', authMiddleware, (req, res) => upsertConfig(req.params.chave, req.body.valor, res));
app.post('/api/config/:chave', authMiddleware, (req, res) => upsertConfig(req.params.chave, req.body.valor ?? req.body.value, res));

// AUTENTICAÇÃO
app.post('/api/admin/criar', async (req, res) => {
  const { username, password } = req.body;
  try {
    const hash = await bcrypt.hash(password, 12);
    await pool.query('INSERT INTO admin_users (username, password_hash) VALUES ($1,$2)', [username, hash]);
    res.json({ ok: true, mensagem: 'Admin criado com sucesso!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reset-senha', async (req, res) => {
  const { username, password } = req.body;
  try {
    const hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE admin_users SET password_hash=$1 WHERE username=$2', [hash, username]);
    res.json({ ok: true, mensagem: 'Senha atualizada com sucesso!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM admin_users WHERE username=$1', [username]);
    if (!rows[0]) return res.status(401).json({ error: 'Usuário não encontrado' });
    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Senha incorreta' });
    const token = jwt.sign({ id: rows[0].id, username: rows[0].username }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Servidor NIMARI rodando em http://localhost:${PORT}`));
