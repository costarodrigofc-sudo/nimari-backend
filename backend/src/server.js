require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const sharp = require('sharp');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

sharp.cache(false);
sharp.concurrency(1);

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.set('trust proxy', 1);

// ==========================================
// SEGURANÇA, COMPRESSÃO E PARSERS
// ==========================================
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(compression());

const allowedOrigins = String(
  process.env.ALLOWED_ORIGINS ||
    'https://www.nimari.com.br,https://nimari.com.br,https://nimari-backend-production.up.railway.app,http://localhost:3000,http://localhost:3001,http://localhost:5173,http://localhost:5500'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      const err = new Error('Origem não permitida pelo CORS.');
      err.status = 403;
      return callback(err);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em instantes.' },
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Tente novamente mais tarde.' },
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ==========================================
// CONEXÃO POSTGRESQL
// ==========================================
const useSsl =
  Boolean(process.env.DATABASE_URL?.includes('railway')) ||
  Boolean(process.env.DB_HOST?.includes('railway')) ||
  Boolean(process.env.DB_HOST?.includes('rlwy.net')) ||
  process.env.NODE_ENV === 'production';

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
    })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || 'railway',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASS || '',
      ssl: useSsl ? { rejectUnauthorized: false } : false,
    });

pool.on('error', (err) => {
  console.error('Erro inesperado no pool do PostgreSQL:', err);
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS produtos (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      descricao TEXT NOT NULL DEFAULT '',
      preco NUMERIC(12, 2) NOT NULL DEFAULT 0,
      preco_antigo NUMERIC(12, 2),
      categoria TEXT NOT NULL DEFAULT 'cosmeticos',
      subcategoria TEXT NOT NULL DEFAULT 'outros-cosm',
      imagem TEXT NOT NULL DEFAULT '',
      imagens JSONB NOT NULL DEFAULT '[]'::jsonb,
      badge TEXT NOT NULL DEFAULT 'none',
      wpp TEXT NOT NULL DEFAULT '',
      mp_link TEXT NOT NULL DEFAULT '',
      vendas INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL DEFAULT 0
    );

    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS descricao TEXT NOT NULL DEFAULT '';
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS preco_antigo NUMERIC(12, 2);
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS categoria TEXT NOT NULL DEFAULT 'cosmeticos';
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS subcategoria TEXT NOT NULL DEFAULT 'outros-cosm';
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS imagem TEXT NOT NULL DEFAULT '';
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS imagens JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS badge TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS wpp TEXT NOT NULL DEFAULT '';
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS mp_link TEXT NOT NULL DEFAULT '';
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS vendas INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS depoimentos (
      id TEXT PRIMARY KEY,
      avatar TEXT NOT NULL DEFAULT '',
      stars INTEGER NOT NULL DEFAULT 5,
      text TEXT NOT NULL,
      name TEXT NOT NULL,
      loc TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL DEFAULT 0
    );

    ALTER TABLE depoimentos ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT '';
    ALTER TABLE depoimentos ADD COLUMN IF NOT EXISTS stars INTEGER NOT NULL DEFAULT 5;
    ALTER TABLE depoimentos ADD COLUMN IF NOT EXISTS loc TEXT NOT NULL DEFAULT '';
    ALTER TABLE depoimentos ADD COLUMN IF NOT EXISTS date TEXT NOT NULL DEFAULT '';
    ALTER TABLE depoimentos ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS config_site (
      id TEXT PRIMARY KEY DEFAULT 'default',
      wpp_number TEXT NOT NULL DEFAULT '5598985631126',
      about_image TEXT NOT NULL DEFAULT '',
      hidden_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
      brands JSONB NOT NULL DEFAULT '[]'::jsonb
    );

    ALTER TABLE config_site ADD COLUMN IF NOT EXISTS wpp_number TEXT NOT NULL DEFAULT '5598985631126';
    ALTER TABLE config_site ADD COLUMN IF NOT EXISTS about_image TEXT NOT NULL DEFAULT '';
    ALTER TABLE config_site ADD COLUMN IF NOT EXISTS hidden_categories JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE config_site ADD COLUMN IF NOT EXISTS brands JSONB NOT NULL DEFAULT '[]'::jsonb;

    INSERT INTO config_site (id, wpp_number, about_image, hidden_categories, brands)
    VALUES ('default', '5598985631126', '', '[]'::jsonb, '[]'::jsonb)
    ON CONFLICT (id) DO NOTHING;
  `);
}

// ==========================================
// CLIENTE CLOUDFLARE R2 (BUCKET: nimari-midia)
// ==========================================
function criarClienteR2() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME || 'nimari-midia';
  const publicUrl = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicUrl) {
    throw new Error('Variáveis do Cloudflare R2 incompletas no ambiente.');
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return { client, bucket, publicUrl };
}

function criarSlug(texto) {
  return (
    String(texto || 'item')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'item'
  );
}

async function bufferParaWebp(inputBuffer) {
  return sharp(inputBuffer)
    .rotate()
    .resize({ width: 1200, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}

// ==========================================
// MULTER EM MEMÓRIA (ATÉ 5 MB)
// ==========================================
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (file.mimetype && ALLOWED_IMAGE_MIMES.has(file.mimetype)) {
      return cb(null, true);
    }
    const err = new Error('Formato de imagem não suportado. Use JPG, PNG, WEBP ou GIF.');
    err.status = 400;
    return cb(err);
  },
});

// ==========================================
// AUTENTICAÇÃO E SESSÃO ADMIN
// ==========================================
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const activeTokens = new Map();
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function timingSafeEqualsStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function criarTokenSessao() {
  const token = crypto.randomBytes(32).toString('hex');
  activeTokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

function tokenSessaoValido(token) {
  if (!token) return false;
  const expiresAt = activeTokens.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    activeTokens.delete(token);
    return false;
  }
  return true;
}

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { password, apiKey } = req.body || {};
  const secretInput = typeof password === 'string' && password ? password : apiKey;

  if (!ADMIN_API_KEY) {
    return res.status(503).json({ error: 'ADMIN_API_KEY não configurada no servidor.' });
  }

  if (!timingSafeEqualsStr(secretInput, ADMIN_API_KEY)) {
    return res.status(401).json({ error: 'Credenciais administrativas inválidas.' });
  }

  const token = criarTokenSessao();
  return res.json({ token, expiresInMs: TOKEN_TTL_MS });
});

app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (token) activeTokens.delete(token);
  return res.json({ ok: true });
});

function autenticarAdmin(req, res, next) {
  if (!ADMIN_API_KEY) {
    return res.status(503).json({ error: 'Autenticação administrativa não configurada no servidor.' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    return res.status(401).json({ error: 'Token de autenticação ausente.' });
  }

  if (timingSafeEqualsStr(token, ADMIN_API_KEY) || tokenSessaoValido(token)) {
    return next();
  }

  return res.status(403).json({ error: 'Acesso administrativo não autorizado.' });
}

// ==========================================
// HELPERS DE SERIALIZAÇÃO (POSTGRESQL)
// ==========================================
function toNumberPrice(val) {
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

function mapProdutoRow(row) {
  const imagens = Array.isArray(row.imagens) ? row.imagens : [];
  return {
    id: row.id,
    nome: row.nome || row.titulo || row.title || 'Produto NIMARI',
    descricao: row.descricao || '',
    preco: Number(row.preco) || 0,
    precoAntigo:
      row.preco_antigo !== null && row.preco_antigo !== undefined ? Number(row.preco_antigo) : null,
    categoria: row.categoria || 'cosmeticos',
    subcategoria: row.subcategoria || 'outros-cosm',
    imagem: row.imagem || imagens[0] || '',
    imagens,
    badge: row.badge || 'none',
    wpp: row.wpp || '',
    mp_link: row.mp_link || '',
    vendas: Number(row.vendas) || 0,
    createdAt: Number(row.created_at) || 0,
  };
}

function mapDepoRow(row) {
  return {
    id: row.id,
    avatar: row.avatar || '',
    stars: Number(row.stars) || 5,
    text: row.text || '',
    name: row.name || '',
    loc: row.loc || '',
    date: row.date || '',
    createdAt: Number(row.created_at) || 0,
  };
}

// ==========================================
// HEALTHCHECK
// ==========================================
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({ status: 'ok', service: 'nimari-backend', timestamp: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: err.message });
  }
});

// ==========================================
// UPLOAD DE IMAGEM -> CONVERSÃO WEBP -> R2
// ==========================================
const PASTAS_PERMITIDAS = new Set(['produtos', 'kits', 'marcas', 'depoimentos']);

app.post('/api/upload', autenticarAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const { client, bucket, publicUrl } = criarClienteR2();
    const pastaSolicitada = String(req.body?.pasta || 'produtos').toLowerCase().trim();
    const pasta = PASTAS_PERMITIDAS.has(pastaSolicitada) ? pastaSolicitada : 'produtos';

    const nomeBase = criarSlug(String(req.file.originalname || 'midia').replace(/\.[^/.]+$/, ''));
    const key = `${pasta}/${nomeBase}-${Date.now()}.webp`;

    const webpBuffer = await bufferParaWebp(req.file.buffer);

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: webpBuffer,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );

    const url = `${publicUrl}/${key}`;
    return res.json({ url, key, format: 'webp' });
  } catch (err) {
    console.error('Erro no /api/upload:', err);
    return res.status(err?.status || 500).json({ error: err.message || 'Erro ao enviar imagem para o R2.' });
  }
});

// ==========================================
// ROTAS DE PRODUTOS (GET PÚBLICO / CRUD ADMIN)
// ==========================================
app.get('/api/produtos', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM produtos ORDER BY COALESCE(created_at, 0) DESC, id DESC');
    return res.json(result.rows.map(mapProdutoRow));
  } catch (err) {
    console.error('Erro ao listar produtos:', err);
    return res.status(500).json({ error: 'Erro ao carregar produtos.', detail: err.message });
  }
});

app.post('/api/produtos', autenticarAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const nome = String(body.nome || '').trim();
    if (!nome) {
      return res.status(400).json({ error: 'Nome do produto é obrigatório.' });
    }

    const id = String(body.id || `prod-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
    const preco = toNumberPrice(body.preco);
    const precoAntigo =
      body.precoAntigo !== undefined && body.precoAntigo !== null && body.precoAntigo !== ''
        ? toNumberPrice(body.precoAntigo)
        : null;
    const imagens = Array.isArray(body.imagens) ? body.imagens.filter(Boolean) : [];
    const imagem = String(body.imagem || imagens[0] || '').trim();
    const createdAt = Number(body.createdAt) || Date.now();

    const result = await pool.query(
      `INSERT INTO produtos (
        id, nome, descricao, preco, preco_antigo, categoria, subcategoria,
        imagem, imagens, badge, wpp, mp_link, vendas, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)
      RETURNING *`,
      [
        id,
        nome,
        String(body.descricao || '').trim(),
        preco,
        precoAntigo,
        String(body.categoria || 'cosmeticos').trim(),
        String(body.subcategoria || 'outros-cosm').trim(),
        imagem,
        JSON.stringify(imagens),
        String(body.badge || 'none').trim(),
        String(body.wpp || '').replace(/\D+/g, ''),
        String(body.mp_link || '').trim(),
        Number(body.vendas) || 0,
        createdAt,
      ]
    );

    return res.status(201).json(mapProdutoRow(result.rows[0]));
  } catch (err) {
    console.error('Erro ao criar produto:', err);
    return res.status(500).json({ error: 'Erro ao criar produto.' });
  }
});

app.put('/api/produtos/:id', autenticarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const existingRes = await pool.query('SELECT * FROM produtos WHERE id = $1', [id]);
    if (existingRes.rowCount === 0) {
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }
    const existing = existingRes.rows[0];
    const body = req.body || {};

    const nome = body.nome !== undefined ? String(body.nome).trim() : existing.nome;
    const descricao = body.descricao !== undefined ? String(body.descricao).trim() : existing.descricao;
    const preco = body.preco !== undefined ? toNumberPrice(body.preco) : Number(existing.preco);
    const precoAntigo =
      body.precoAntigo === null || body.precoAntigo === ''
        ? null
        : body.precoAntigo !== undefined
        ? toNumberPrice(body.precoAntigo)
        : existing.preco_antigo;
    const categoria = body.categoria !== undefined ? String(body.categoria).trim() : existing.categoria;
    const subcategoria =
      body.subcategoria !== undefined ? String(body.subcategoria).trim() : existing.subcategoria;
    const imagens = Array.isArray(body.imagens)
      ? body.imagens.filter(Boolean)
      : Array.isArray(existing.imagens)
      ? existing.imagens
      : [];
    const imagem = body.imagem !== undefined ? String(body.imagem).trim() : existing.imagem;
    const badge = body.badge !== undefined ? String(body.badge).trim() : existing.badge;
    const wpp = body.wpp !== undefined ? String(body.wpp).replace(/\D+/g, '') : existing.wpp;
    const mpLink = body.mp_link !== undefined ? String(body.mp_link).trim() : existing.mp_link;

    const updated = await pool.query(
      `UPDATE produtos
       SET nome = $1, descricao = $2, preco = $3, preco_antigo = $4,
           categoria = $5, subcategoria = $6, imagem = $7, imagens = $8::jsonb,
           badge = $9, wpp = $10, mp_link = $11
       WHERE id = $12
       RETURNING *`,
      [
        nome,
        descricao,
        preco,
        precoAntigo,
        categoria,
        subcategoria,
        imagem,
        JSON.stringify(imagens),
        badge,
        wpp,
        mpLink,
        id,
      ]
    );

    return res.json(mapProdutoRow(updated.rows[0]));
  } catch (err) {
    console.error('Erro ao atualizar produto:', err);
    return res.status(500).json({ error: 'Erro ao atualizar produto.' });
  }
});

app.delete('/api/produtos/:id', autenticarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await pool.query('DELETE FROM produtos WHERE id = $1 RETURNING id', [id]);
    if (deleted.rowCount === 0) {
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }
    return res.json({ ok: true, id });
  } catch (err) {
    console.error('Erro ao excluir produto:', err);
    return res.status(500).json({ error: 'Erro ao excluir produto.' });
  }
});

app.delete('/api/produtos', autenticarAdmin, async (_req, res) => {
  try {
    await pool.query('DELETE FROM produtos');
    return res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao excluir todos os produtos:', err);
    return res.status(500).json({ error: 'Erro ao limpar produtos.' });
  }
});

// ==========================================
// ROTAS DE DEPOIMENTOS (GET PÚBLICO / CRUD ADMIN)
// ==========================================
app.get('/api/depoimentos', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM depoimentos ORDER BY COALESCE(created_at, 0) DESC, id DESC');
    return res.json(result.rows.map(mapDepoRow));
  } catch (err) {
    console.error('Erro ao listar depoimentos:', err);
    return res.status(500).json({ error: 'Erro ao carregar depoimentos.' });
  }
});

app.post('/api/depoimentos', autenticarAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const text = String(body.text || '').trim();
    if (!name || !text) {
      return res.status(400).json({ error: 'Nome e depoimento são obrigatórios.' });
    }

    const id = String(body.id || `depo-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
    const stars = Math.min(5, Math.max(1, Number(body.stars) || 5));
    const createdAt = Number(body.createdAt) || Date.now();

    const result = await pool.query(
      `INSERT INTO depoimentos (id, avatar, stars, text, name, loc, date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        String(body.avatar || '').trim(),
        stars,
        text,
        name,
        String(body.loc || '').trim(),
        String(body.date || '').trim(),
        createdAt,
      ]
    );

    return res.status(201).json(mapDepoRow(result.rows[0]));
  } catch (err) {
    console.error('Erro ao criar depoimento:', err);
    return res.status(500).json({ error: 'Erro ao criar depoimento.' });
  }
});

app.put('/api/depoimentos/:id', autenticarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const existingRes = await pool.query('SELECT * FROM depoimentos WHERE id = $1', [id]);
    if (existingRes.rowCount === 0) {
      return res.status(404).json({ error: 'Depoimento não encontrado.' });
    }
    const existing = existingRes.rows[0];
    const body = req.body || {};

    const updated = await pool.query(
      `UPDATE depoimentos
       SET avatar = $1, stars = $2, text = $3, name = $4, loc = $5, date = $6
       WHERE id = $7
       RETURNING *`,
      [
        body.avatar !== undefined ? String(body.avatar).trim() : existing.avatar,
        body.stars !== undefined ? Math.min(5, Math.max(1, Number(body.stars) || 5)) : existing.stars,
        body.text !== undefined ? String(body.text).trim() : existing.text,
        body.name !== undefined ? String(body.name).trim() : existing.name,
        body.loc !== undefined ? String(body.loc).trim() : existing.loc,
        body.date !== undefined ? String(body.date).trim() : existing.date,
        id,
      ]
    );

    return res.json(mapDepoRow(updated.rows[0]));
  } catch (err) {
    console.error('Erro ao atualizar depoimento:', err);
    return res.status(500).json({ error: 'Erro ao atualizar depoimento.' });
  }
});

app.delete('/api/depoimentos/:id', autenticarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await pool.query('DELETE FROM depoimentos WHERE id = $1 RETURNING id', [id]);
    if (deleted.rowCount === 0) {
      return res.status(404).json({ error: 'Depoimento não encontrado.' });
    }
    return res.json({ ok: true, id });
  } catch (err) {
    console.error('Erro ao excluir depoimento:', err);
    return res.status(500).json({ error: 'Erro ao excluir depoimento.' });
  }
});

// ==========================================
// ROTAS DE CONFIGURAÇÃO (GET PÚBLICO / PUT ADMIN)
// ==========================================
app.get('/api/config', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM config_site WHERE id = $1', ['default']);
    const row = result.rows[0] || {};
    return res.json({
      wppNumber: row.wpp_number || '5598985631126',
      aboutImage: row.about_image || '',
      hiddenCategories: Array.isArray(row.hidden_categories) ? row.hidden_categories : [],
      brands: Array.isArray(row.brands) ? row.brands : [],
    });
  } catch (err) {
    console.error('Erro ao buscar configurações:', err);
    return res.status(500).json({ error: 'Erro ao carregar configurações.' });
  }
});

app.put('/api/config', autenticarAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const currentRes = await pool.query('SELECT * FROM config_site WHERE id = $1', ['default']);
    const current = currentRes.rows[0] || {};

    const wppNumber =
      body.wppNumber !== undefined
        ? String(body.wppNumber).replace(/\D+/g, '') || '5598985631126'
        : current.wpp_number || '5598985631126';
    const aboutImage =
      body.aboutImage !== undefined ? String(body.aboutImage).trim() : current.about_image || '';
    const hiddenCategories = Array.isArray(body.hiddenCategories)
      ? body.hiddenCategories
      : Array.isArray(current.hidden_categories)
      ? current.hidden_categories
      : [];
    const brands = Array.isArray(body.brands)
      ? body.brands
      : Array.isArray(current.brands)
      ? current.brands
      : [];

    await pool.query(
      `INSERT INTO config_site (id, wpp_number, about_image, hidden_categories, brands)
       VALUES ('default', $1, $2, $3::jsonb, $4::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         wpp_number = EXCLUDED.wpp_number,
         about_image = EXCLUDED.about_image,
         hidden_categories = EXCLUDED.hidden_categories,
         brands = EXCLUDED.brands`,
      [wppNumber, aboutImage, JSON.stringify(hiddenCategories), JSON.stringify(brands)]
    );

    return res.json({ wppNumber, aboutImage, hiddenCategories, brands });
  } catch (err) {
    console.error('Erro ao salvar configurações:', err);
    return res.status(500).json({ error: 'Erro ao salvar configurações.' });
  }
});

// ==========================================
// FRONT-END ESTÁTICO (RAIZ DO PROJETO)
// ==========================================
const publicDir = path.join(__dirname, '..', '..');

app.use(
  express.static(publicDir, {
    index: 'index.html',
    extensions: ['html'],
  })
);

app.use('/backend', (_req, res) => res.status(404).end());

app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ==========================================
// TRATAMENTO GLOBAL DE ERROS
// ==========================================
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Arquivo excede o limite de 5 MB.' });
    }
    return res.status(400).json({ error: `Erro no upload: ${err.message}` });
  }
  console.error('Erro não tratado no servidor:', err);
  return res.status(err?.status || 500).json({ error: err?.message || 'Erro interno do servidor.' });
});

initDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Servidor NIMARI rodando na porta ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Falha ao inicializar banco de dados:', err);
    process.exit(1);
  });