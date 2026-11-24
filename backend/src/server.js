require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const REQUIRED_ENV = ['JWT_SECRET', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Variável de ambiente obrigatória ausente: ${key}`);
    process.exit(1);
  }
}

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    : null;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
});

const app = express();
app.set('trust proxy', 1);

const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  'https://www.nimari.com.br,https://nimari.com.br'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (process.env.NODE_ENV !== 'production') {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:5500');
}

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(compression());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Origem não permitida pelo CORS'));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));

// Evita cache apenas em respostas dinâmicas da API
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB
    files: 1,
  },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error('Formato de imagem inválido. Use JPG, PNG, WEBP, AVIF ou GIF.'));
    }
    cb(null, true);
  },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
});

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) {
    return res.status(401).json({ error: 'Token ausente' });
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

function adminSetupGuard(req, res, next) {
  if (process.env.ENABLE_ADMIN_SETUP !== 'true') {
    return res.status(403).json({ error: 'Rota administrativa desativada neste ambiente' });
  }
  return next();
}

function sanitizeMpLink(link) {
  if (!link || typeof link !== 'string') return '';
  const trimmed = link.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

// UPLOAD
app.post('/api/upload', authMiddleware, (req, res, next) => {
  upload.single('imagem')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Arquivo excede o limite de 5 MB' });
      }
      return res.status(400).json({ error: 'Erro no envio do arquivo' });
    }
    if (err) {
      return res.status(400).json({ error: err.message || 'Arquivo inválido' });
    }
    return next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhuma imagem enviada' });
    }
    if (!supabase) {
      return res.status(503).json({ error: 'Serviço de storage não configurado' });
    }

    const extMap = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/avif': 'avif',
      'image/gif': 'gif',
    };
    const ext = extMap[req.file.mimetype] || 'webp';
    const nome = `Produtos/${Date.now()}.${ext}`;

    const { error } = await supabase.storage
      .from('Produtos')
      .upload(nome, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });

    if (error) {
      console.error('Erro Supabase upload:', error.message);
      return res.status(500).json({ error: 'Falha ao enviar imagem para o storage' });
    }

    const { data } = supabase.storage.from('Produtos').getPublicUrl(nome);
    return res.json({ url: data.publicUrl });
  } catch (err) {
    console.error('Erro /api/upload:', err);
    return res.status(500).json({ error: 'Erro interno no upload' });
  }
});

// PRODUTOS
app.get('/api/produtos', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM produtos WHERE ativo = TRUE ORDER BY criado_em DESC'
    );
    return res.json(rows);
  } catch (err) {
    console.error('Erro GET /api/produtos:', err);
    return res.status(500).json({ error: 'Erro ao buscar produtos' });
  }
});

app.post('/api/produtos', authMiddleware, async (req, res) => {
  const { uid, name, descricao, price, price_old, img, badge, cat, sub, wpp, mp_link, imagens } = req.body;
  if (!uid || !name || !price) {
    return res.status(400).json({ error: 'Campos obrigatórios: uid, name e price' });
  }

  const imagensArr = Array.isArray(imagens) ? imagens : imagens ? [imagens] : [];
  const safeMpLink = sanitizeMpLink(mp_link);

  try {
    const { rows } = await pool.query(
      `INSERT INTO produtos (uid, name, descricao, price, price_old, img, badge, cat, sub, wpp, mp_link, imagens)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        uid,
        name,
        descricao || '',
        price,
        price_old || '',
        img || '',
        badge || 'none',
        cat || 'cosmeticos',
        sub || 'pele',
        wpp || '',
        safeMpLink,
        imagensArr,
      ]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Erro POST /api/produtos:', err);
    return res.status(500).json({ error: 'Erro ao criar produto' });
  }
});

app.put('/api/produtos/:uid', authMiddleware, async (req, res) => {
  const { name, descricao, price, price_old, img, badge, cat, sub, wpp, mp_link, imagens } = req.body;
  const imagensArr = Array.isArray(imagens) ? imagens : imagens ? [imagens] : [];
  const safeMpLink = sanitizeMpLink(mp_link);

  try {
    const { rows } = await pool.query(
      `UPDATE produtos
       SET name=$1, descricao=$2, price=$3, price_old=$4, img=$5, badge=$6, cat=$7, sub=$8, wpp=$9, mp_link=$10, imagens=$11, updated_at=NOW()
       WHERE uid=$12
       RETURNING *`,
      [
        name,
        descricao || '',
        price,
        price_old || '',
        img || '',
        badge || 'none',
        cat || 'cosmeticos',
        sub || 'pele',
        wpp || '',
        safeMpLink,
        imagensArr,
        req.params.uid,
      ]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    return res.json(rows[0]);
  } catch (err) {
    console.error('Erro PUT /api/produtos/:uid:', err);
    return res.status(500).json({ error: 'Erro ao atualizar produto' });
  }
});

app.delete('/api/produtos/:uid', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE produtos SET ativo=FALSE, updated_at=NOW() WHERE uid=$1',
      [req.params.uid]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('Erro DELETE /api/produtos/:uid:', err);
    return res.status(500).json({ error: 'Erro ao remover produto' });
  }
});

// DEPOIMENTOS
app.get('/api/depoimentos', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM depoimentos WHERE ativo = TRUE ORDER BY criado_em DESC'
    );
    return res.json(rows);
  } catch (err) {
    console.error('Erro GET /api/depoimentos:', err);
    return res.status(500).json({ error: 'Erro ao buscar depoimentos' });
  }
});

app.post('/api/depoimentos', authMiddleware, async (req, res) => {
  const { nome, texto, estrelas, local, data, avatar } = req.body;
  if (!nome || !texto) {
    return res.status(400).json({ error: 'Nome e texto são obrigatórios' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO depoimentos (nome, texto, estrelas, local, data, avatar)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [nome, texto, estrelas || 5, local || '', data || '', avatar || '']
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Erro POST /api/depoimentos:', err);
    return res.status(500).json({ error: 'Erro ao salvar depoimento' });
  }
});

app.delete('/api/depoimentos/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE depoimentos SET ativo=FALSE WHERE id=$1', [req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Erro DELETE /api/depoimentos/:id:', err);
    return res.status(500).json({ error: 'Erro ao remover depoimento' });
  }
});

// MARCAS
app.get('/api/marcas', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM marcas WHERE ativo = TRUE ORDER BY ordem ASC'
    );
    return res.json(rows);
  } catch (err) {
    console.error('Erro GET /api/marcas:', err);
    return res.status(500).json({ error: 'Erro ao buscar marcas' });
  }
});

app.post('/api/marcas', authMiddleware, async (req, res) => {
  const { nome, logo_url, ordem } = req.body;
  if (!nome || !logo_url) {
    return res.status(400).json({ error: 'Nome e logo_url são obrigatórios' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO marcas (nome, logo_url, ordem) VALUES ($1,$2,$3) RETURNING *`,
      [nome, logo_url, ordem || 0]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Erro POST /api/marcas:', err);
    return res.status(500).json({ error: 'Erro ao adicionar marca' });
  }
});

app.put('/api/marcas/:id', authMiddleware, async (req, res) => {
  const { nome, logo_url, ordem } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE marcas SET nome=$1, logo_url=$2, ordem=$3 WHERE id=$4 RETURNING *`,
      [nome, logo_url, ordem, req.params.id]
    );
    return res.json(rows[0] || {});
  } catch (err) {
    console.error('Erro PUT /api/marcas/:id:', err);
    return res.status(500).json({ error: 'Erro ao atualizar marca' });
  }
});

app.delete('/api/marcas/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE marcas SET ativo=FALSE WHERE id=$1', [req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Erro DELETE /api/marcas/:id:', err);
    return res.status(500).json({ error: 'Erro ao remover marca' });
  }
});

// CONFIGURAÇÕES
app.get('/api/config/:chave', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT valor FROM configuracoes WHERE chave=$1',
      [req.params.chave]
    );
    return res.json(rows[0] || null);
  } catch (err) {
    console.error('Erro GET /api/config/:chave:', err);
    return res.status(500).json({ error: 'Erro ao buscar configuração' });
  }
});

async function upsertConfig(chave, valor, res) {
  try {
    await pool.query(
      `INSERT INTO configuracoes (chave, valor)
       VALUES ($1,$2)
       ON CONFLICT (chave) DO UPDATE SET valor=$2, updated_at=NOW()`,
      [chave, valor ?? '']
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('Erro upsertConfig:', err);
    return res.status(500).json({ error: 'Erro ao salvar configuração' });
  }
}

app.put('/api/config/:chave', authMiddleware, (req, res) =>
  upsertConfig(req.params.chave, req.body.valor, res)
);
app.post('/api/config/:chave', authMiddleware, (req, res) =>
  upsertConfig(req.params.chave, req.body.valor ?? req.body.value, res)
);

// AUTENTICAÇÃO
app.post('/api/admin/criar', adminSetupGuard, authMiddleware, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || String(password).length < 8) {
    return res.status(400).json({ error: 'Usuário e senha (mínimo 8 caracteres) são obrigatórios' });
  }
  try {
    const hash = await bcrypt.hash(String(password), 12);
    await pool.query(
      'INSERT INTO admin_users (username, password_hash) VALUES ($1,$2)',
      [String(username).trim(), hash]
    );
    return res.status(201).json({ ok: true, mensagem: 'Admin criado com sucesso!' });
  } catch (err) {
    console.error('Erro POST /api/admin/criar:', err);
    return res.status(500).json({ error: 'Erro ao criar usuário admin' });
  }
});

app.post('/api/admin/reset-senha', adminSetupGuard, authMiddleware, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || String(password).length < 8) {
    return res.status(400).json({ error: 'Usuário e nova senha (mínimo 8 caracteres) são obrigatórios' });
  }
  try {
    const hash = await bcrypt.hash(String(password), 12);
    const result = await pool.query(
      'UPDATE admin_users SET password_hash=$1 WHERE username=$2',
      [hash, String(username).trim()]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    return res.json({ ok: true, mensagem: 'Senha atualizada com sucesso!' });
  } catch (err) {
    console.error('Erro POST /api/admin/reset-senha:', err);
    return res.status(500).json({ error: 'Erro ao atualizar senha' });
  }
});

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, username, password_hash FROM admin_users WHERE username=$1',
      [String(username).trim()]
    );
    if (!rows[0]) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    const ok = await bcrypt.compare(String(password), rows[0].password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    const token = jwt.sign(
      { id: rows[0].id, username: rows[0].username },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );
    return res.json({ token });
  } catch (err) {
    console.error('Erro POST /api/admin/login:', err);
    return res.status(500).json({ error: 'Erro ao autenticar' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  if (err && err.message === 'Origem não permitida pelo CORS') {
    return res.status(403).json({ error: err.message });
  }
  console.error('Erro não tratado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ API NIMARI rodando na porta ${PORT}`));