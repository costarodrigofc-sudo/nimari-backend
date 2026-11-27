require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const sharp = require('sharp');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// ==========================================
// CONFIGURAÇÃO
// ==========================================
const PORT = Number(process.env.PORT || 3000);
// Frontend fica em /public (index.html, admin.html, produto.html, app.js, admin.js, styles.css, favicon_io/)
const PUBLIC_ROOT = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, '..', '..', 'public'));

const DATABASE_URL = process.env.DATABASE_URL || '';
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const JWT_SECRET =
  String(process.env.JWT_SECRET || '').trim() ||
  (ADMIN_PASSWORD ? crypto.createHash('sha256').update(`nimari:${ADMIN_PASSWORD}`).digest('hex') : '');

if (!DATABASE_URL) {
  console.error('[erro] DATABASE_URL não definida.');
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.error('[erro] ADMIN_PASSWORD não definida.');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.warn('[aviso] JWT_SECRET não definido; usando segredo derivado da senha. Defina JWT_SECRET no Railway.');
}

// ==========================================
// POSTGRESQL (RAILWAY)
// ==========================================
const isInternalUrl = /railway\.internal/.test(DATABASE_URL);
const useSsl = process.env.DATABASE_SSL
  ? process.env.DATABASE_SSL === 'true'
  : !isInternalUrl && /rlwy\.net|railway\.app/.test(DATABASE_URL);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 10,
});
pool.on('error', (err) => console.error('Erro inesperado no pool do Postgres:', err.message));

// ==========================================
// CLOUDFLARE R2
// ==========================================
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || '';
const R2_PUBLIC_URL = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

const r2Client =
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY
    ? new S3Client({
        region: 'auto',
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
      })
    : null;

// ==========================================
// SCHEMA (cria a tabela e migra o formato antigo automaticamente)
// ==========================================
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS produtos (id SERIAL PRIMARY KEY);

-- Colunas do formato antigo -> formato novo
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('name','nome'), ('price','preco'), ('price_old','preco_antigo'),
      ('img','imagem'), ('cat','categoria'), ('sub','subcategoria')
  ) AS t(old_name, new_name)
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = current_schema() AND table_name = 'produtos' AND column_name = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = current_schema() AND table_name = 'produtos' AND column_name = r.new_name)
    THEN
      EXECUTE format('ALTER TABLE produtos RENAME COLUMN %I TO %I', r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

ALTER TABLE produtos
  ADD COLUMN IF NOT EXISTS sku TEXT,
  ADD COLUMN IF NOT EXISTS nome TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS descricao TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS categoria TEXT NOT NULL DEFAULT 'cosmeticos',
  ADD COLUMN IF NOT EXISTS subcategoria TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS marca TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS preco NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS preco_antigo NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS badge TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS imagem TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS imagens JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS wpp TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS mp_link TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Colunas legadas (ex.: uid) com NOT NULL sem default não podem travar novos INSERTs
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'produtos'
      AND is_nullable = 'NO' AND column_default IS NULL AND column_name <> 'id'
  LOOP
    EXECUTE format('ALTER TABLE produtos ALTER COLUMN %I DROP NOT NULL', c.column_name);
  END LOOP;
END $$;

-- SKU = uid antigo (mantém links /produto/UID funcionando)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'produtos' AND column_name = 'uid') THEN
    EXECUTE $q$UPDATE produtos SET sku = uid::text
                WHERE (sku IS NULL OR sku = '') AND uid IS NOT NULL AND uid::text <> ''$q$;
  END IF;
END $$;

UPDATE produtos SET sku = 'NIM-' || id WHERE sku IS NULL OR sku = '';
UPDATE produtos p SET sku = p.sku || '-' || p.id
 WHERE p.id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY sku ORDER BY id) AS rn FROM produtos) d WHERE d.rn > 1);
UPDATE produtos SET ativo = TRUE WHERE ativo IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS produtos_sku_uq ON produtos (sku);
`;

async function ensureSchema() {
  await pool.query(SCHEMA_SQL);
}

// ==========================================
// MIDDLEWARES
// ==========================================
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

const corsOrigins = String(process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use('/api', cors({ origin: corsOrigins.length ? corsOrigins : true }));
app.use(express.json({ limit: '2mb' }));

app.use(
  '/api/',
  rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: true, legacyHeaders: false })
);
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Aguarde alguns minutos.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype)) return cb(null, true);
    cb(new ValidationError('Envie apenas imagens JPG, PNG, WEBP ou GIF.'));
  },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ==========================================
// AUTENTICAÇÃO ADMIN
// ==========================================
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function signAdminToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
  if (!sig || !safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function getSession(req) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return verifyAdminToken(token);
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Sessão administrativa inválida ou expirada.' });
  req.admin = session;
  next();
}

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const pwd = String(req.body && req.body.password ? req.body.password : '').trim();
  if (!pwd || !safeEqual(pwd, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }
  const token = signAdminToken({ role: 'admin', iat: Date.now(), exp: Date.now() + 12 * 60 * 60 * 1000 });
  res.json({ ok: true, token });
});

// ==========================================
// VALIDAÇÃO / NORMALIZAÇÃO DE PRODUTO
// ==========================================
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const SUBCATEGORIAS = {
  cosmeticos: ['pele', 'cabelo', 'perf-fem', 'perf-masc', 'infantil-cosm', 'outros-cosm'],
  confeccao: ['intima-fem', 'moda-fem', 'intima-inf', 'sutia', 'calcinha', 'outros-conf'],
  kit: ['kit-presente'],
};
const BADGES = new Set(['none', 'novo', 'oferta', 'vendido', 'esgotado']);

const text = (v, max) => String(v ?? '').trim().slice(0, max);

function parsePrice(val) {
  if (typeof val === 'number') return Number.isFinite(val) ? Number(val.toFixed(2)) : 0;
  if (val === null || val === undefined) return 0;
  const raw = String(val).trim();
  if (!raw) return 0;
  if (/^\d{1,3}(\.\d{3})*,\d{1,2}$/.test(raw)) {
    const n = Number(raw.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
  }
  const cleaned = raw.replace(/,/g, '.').replace(/[^0-9.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function normalizeCategory(cat) {
  const c = String(cat || 'cosmeticos').trim().toLowerCase();
  if (c.includes('confec') || c.includes('intima') || c.includes('moda')) return 'confeccao';
  if (c.includes('kit')) return 'kit';
  return 'cosmeticos';
}

function cleanUrl(v) {
  const u = text(v, 1000);
  if (!u) return '';
  if (/^(javascript|data|vbscript):/i.test(u)) throw new ValidationError('URL de imagem inválida.');
  return u;
}

const randomSku = () =>
  `NIM-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

// SKU determinístico: reimportar a mesma planilha ATUALIZA em vez de duplicar
const deterministicSku = (nome, categoria) =>
  'NIM-' +
  crypto.createHash('sha1').update(`${categoria}|${nome.toLowerCase()}`).digest('hex').slice(0, 10).toUpperCase();

// Lê só os campos que realmente vieram no corpo (aceita nomes novos e antigos)
function readFields(body) {
  const b = body && typeof body === 'object' ? body : {};
  const map = [
    ['sku', ['sku']],
    ['nome', ['nome', 'name']],
    ['descricao', ['descricao']],
    ['categoria', ['categoria']],
    ['subcategoria', ['subcategoria']],
    ['marca', ['marca']],
    ['preco', ['preco', 'price']],
    ['preco_antigo', ['preco_antigo', 'priceOld']],
    ['badge', ['badge']],
    ['imagem', ['imagem']],
    ['imagens', ['imagens']],
    ['ativo', ['ativo']],
    ['wpp', ['wpp']],
    ['mp_link', ['mp_link', 'mpLink']],
  ];
  const out = {};
  for (const [field, keys] of map) {
    for (const k of keys) {
      if (b[k] !== undefined) {
        out[field] = b[k];
        break;
      }
    }
  }
  return out;
}

// Valida um produto COMPLETO e devolve os valores prontos para o banco
function validateProduct(f, opts = {}) {
  const nome = text(f.nome, 200);
  if (!nome) throw new ValidationError('O nome do produto é obrigatório.');

  const categoria = normalizeCategory(f.categoria);
  const sub = text(f.subcategoria, 40);
  const subcategoria = SUBCATEGORIAS[categoria].includes(sub) ? sub : '';

  const preco = parsePrice(f.preco);
  if (preco < 0 || preco > 999999.99) throw new ValidationError('Preço fora do intervalo permitido.');

  const hasOld = f.preco_antigo !== undefined && f.preco_antigo !== null && String(f.preco_antigo).trim() !== '';
  const old = hasOld ? parsePrice(f.preco_antigo) : 0;
  const preco_antigo = old > preco ? old : null;

  const badgeRaw = text(f.badge || 'none', 20).toLowerCase();
  const badge = BADGES.has(badgeRaw) ? badgeRaw : 'none';

  const lista = (Array.isArray(f.imagens) ? f.imagens : []).map(cleanUrl).filter(Boolean);
  const imagem = cleanUrl(f.imagem) || lista[0] || '';
  const imagens = [...new Set(imagem ? [imagem, ...lista] : lista)].slice(0, 10);

  const mp_link = text(f.mp_link, 500);
  if (mp_link && !/^https:\/\//i.test(mp_link)) throw new ValidationError('O link do Mercado Pago deve começar com https://');

  const ativoRaw = f.ativo;
  const ativo = !(ativoRaw === false || ativoRaw === 0 || String(ativoRaw).toLowerCase() === 'false');

  const sku =
    text(f.sku, 64).toUpperCase() ||
    (typeof opts.skuFallback === 'function' ? opts.skuFallback(nome, categoria) : randomSku());

  return {
    sku,
    nome,
    descricao: text(f.descricao, 2000),
    categoria,
    subcategoria,
    marca: text(f.marca, 100),
    preco,
    preco_antigo,
    badge,
    imagem,
    imagens,
    ativo,
    wpp: String(f.wpp ?? '').replace(/\D+/g, '').slice(0, 15),
    mp_link,
  };
}

function rowToFields(row) {
  return {
    sku: row.sku,
    nome: row.nome,
    descricao: row.descricao || '',
    categoria: row.categoria,
    subcategoria: row.subcategoria || '',
    marca: row.marca || '',
    preco: row.preco,
    preco_antigo: row.preco_antigo,
    badge: row.badge || 'none',
    imagem: row.imagem || '',
    imagens: Array.isArray(row.imagens) ? row.imagens : [],
    ativo: row.ativo !== false,
    wpp: row.wpp || '',
    mp_link: row.mp_link || '',
  };
}

// Edição parcial: só altera o que veio no corpo; o resto é preservado
function mergeForUpdate(row, patch) {
  const current = rowToFields(row);
  const merged = { ...current, ...patch };
  if (patch.imagem !== undefined && patch.imagens === undefined) {
    const keep = current.imagens.filter((u) => u !== row.imagem);
    const novo = text(patch.imagem, 1000);
    merged.imagens = novo ? [novo, ...keep.filter((u) => u !== novo)] : keep;
  }
  if (!text(patch.sku, 64)) merged.sku = row.sku; // nunca troca o SKU sem pedido explícito
  return merged;
}

// Mantém compatibilidade com produto.html / app.js (nomes antigos e novos)
function serialize(row) {
  const preco = Number(row.preco) || 0;
  const antigo = row.preco_antigo == null ? null : Number(row.preco_antigo);
  return {
    ...row,
    preco,
    preco_antigo: antigo,
    imagens: Array.isArray(row.imagens) ? row.imagens : [],
    uid: row.sku,
    name: row.nome,
    price: preco,
    price_old: antigo,
    img: row.imagem,
    cat: row.categoria,
    sub: row.subcategoria,
    mpLink: row.mp_link || '',
  };
}

const INSERT_SQL = `
  INSERT INTO produtos
    (sku, nome, descricao, categoria, subcategoria, marca, preco, preco_antigo, badge, imagem, imagens, ativo, wpp, mp_link)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)`;

const insertValues = (p) => [
  p.sku, p.nome, p.descricao, p.categoria, p.subcategoria, p.marca, p.preco, p.preco_antigo,
  p.badge, p.imagem, JSON.stringify(p.imagens), p.ativo, p.wpp, p.mp_link,
];

// ==========================================
// ROTAS DE PRODUTOS
// ==========================================
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get(
  '/api/produtos',
  wrap(async (req, res) => {
    const all = req.query.all === '1';
    if (all && !getSession(req)) {
      return res.status(401).json({ error: 'Sessão administrativa inválida ou expirada.' });
    }
    const sql = all
      ? 'SELECT * FROM produtos ORDER BY id DESC'
      : 'SELECT * FROM produtos WHERE ativo = TRUE ORDER BY id DESC';
    const { rows } = await pool.query(sql);
    res.json(rows.map(serialize));
  })
);

app.post(
  '/api/produtos',
  requireAdmin,
  wrap(async (req, res) => {
    const p = validateProduct(readFields(req.body));
    const { rows } = await pool.query(`${INSERT_SQL} RETURNING *`, insertValues(p));
    res.status(201).json(serialize(rows[0]));
  })
);

// Importação em lote (upsert por SKU; sem SKU, usa nome+categoria)
app.post(
  '/api/produtos/batch',
  requireAdmin,
  wrap(async (req, res) => {
    const list = req.body && Array.isArray(req.body.produtos) ? req.body.produtos : [];
    if (list.length === 0) {
      return res.status(400).json({ error: 'Envie uma lista em "produtos" para importar em lote.' });
    }
    if (list.length > 500) {
      return res.status(400).json({ error: 'Máximo de 500 produtos por importação.' });
    }

    const prepared = [];
    const errors = [];
    list.forEach((item, i) => {
      try {
        prepared.push(validateProduct(readFields(item), { skuFallback: deterministicSku }));
      } catch (e) {
        errors.push(`Linha ${i + 2}: ${e.message}`);
      }
    });
    if (errors.length) {
      return res.status(400).json({
        error: 'Há linhas inválidas na planilha. Nada foi importado.',
        detail: errors.slice(0, 10).join(' | '),
        errors,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = [];
      let criados = 0;
      for (const p of prepared) {
        const r = await client.query(
          `${INSERT_SQL}
           ON CONFLICT (sku) DO UPDATE SET
             nome = EXCLUDED.nome,
             descricao = CASE WHEN EXCLUDED.descricao <> '' THEN EXCLUDED.descricao ELSE produtos.descricao END,
             categoria = EXCLUDED.categoria,
             subcategoria = CASE WHEN EXCLUDED.subcategoria <> '' THEN EXCLUDED.subcategoria ELSE produtos.subcategoria END,
             marca = CASE WHEN EXCLUDED.marca <> '' THEN EXCLUDED.marca ELSE produtos.marca END,
             preco = EXCLUDED.preco,
             preco_antigo = COALESCE(EXCLUDED.preco_antigo, produtos.preco_antigo),
             badge = CASE WHEN EXCLUDED.badge <> 'none' THEN EXCLUDED.badge ELSE produtos.badge END,
             imagem = CASE WHEN EXCLUDED.imagem <> '' THEN EXCLUDED.imagem ELSE produtos.imagem END,
             imagens = CASE WHEN jsonb_array_length(EXCLUDED.imagens) > 0 THEN EXCLUDED.imagens ELSE produtos.imagens END,
             ativo = EXCLUDED.ativo,
             updated_at = NOW()
           RETURNING *, (xmax = 0) AS inserted`,
          insertValues(p)
        );
        const { inserted, ...row } = r.rows[0];
        if (inserted) criados += 1;
        out.push(serialize(row));
      }
      await client.query('COMMIT');
      res.status(201).json({
        ok: true,
        count: out.length,
        criados,
        atualizados: out.length - criados,
        produtos: out,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  })
);

const updateProduct = wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID inválido.' });

  const patch = readFields(req.body);
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar.' });
  }

  const cur = await pool.query('SELECT * FROM produtos WHERE id = $1', [id]);
  if (cur.rowCount === 0) return res.status(404).json({ error: 'Produto não encontrado.' });

  const p = validateProduct(mergeForUpdate(cur.rows[0], patch));
  const { rows } = await pool.query(
    `UPDATE produtos SET
       sku = $1, nome = $2, descricao = $3, categoria = $4, subcategoria = $5, marca = $6,
       preco = $7, preco_antigo = $8, badge = $9, imagem = $10, imagens = $11::jsonb,
       ativo = $12, wpp = $13, mp_link = $14, updated_at = NOW()
     WHERE id = $15
     RETURNING *`,
    [...insertValues(p), id]
  );
  res.json(serialize(rows[0]));
});

app.put('/api/produtos/:id', requireAdmin, updateProduct);
app.patch('/api/produtos/:id', requireAdmin, updateProduct);

app.delete(
  '/api/produtos/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID inválido.' });
    const r = await pool.query('DELETE FROM produtos WHERE id = $1 RETURNING id', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Produto não encontrado.' });
    res.json({ ok: true, deletedId: id });
  })
);

// ==========================================
// UPLOAD DE IMAGEM -> WEBP NO CLOUDFLARE R2
// ==========================================
const PASTAS = new Set(['produtos', 'sobre', 'marcas']);

app.post(
  '/api/upload',
  requireAdmin,
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    if (!r2Client || !R2_BUCKET_NAME || !R2_PUBLIC_URL) {
      return res.status(503).json({ error: 'Cloudflare R2 não configurado nas variáveis de ambiente.' });
    }

    const pastaReq = String(req.body && req.body.pasta ? req.body.pasta : 'produtos').toLowerCase();
    const pasta = PASTAS.has(pastaReq) ? pastaReq : 'produtos';
    const key = `${pasta}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.webp`;

    let webpBuffer;
    try {
      webpBuffer = await sharp(req.file.buffer)
        .rotate()
        .resize({ width: 1200, withoutEnlargement: true })
        .webp({ quality: 84 })
        .toBuffer();
    } catch {
      return res.status(400).json({ error: 'Arquivo de imagem inválido ou corrompido.' });
    }

    await r2Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: webpBuffer,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );

    res.json({ ok: true, key, url: `${R2_PUBLIC_URL}/${key}` });
  })
);

// ==========================================
// CONFIG & DEPOIMENTOS (fallback)
// ==========================================
app.get('/api/config', (_req, res) => {
  res.json({
    wppNumber: process.env.WPP_NUMBER || '5598985631126',
    aboutImage: '',
    hiddenCategories: [],
    brands: [],
  });
});

app.get('/api/depoimentos', (_req, res) => res.json([]));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

// ==========================================
// ARQUIVOS ESTÁTICOS E PÁGINAS
// ==========================================
app.use(
  express.static(PUBLIC_ROOT, {
    dotfiles: 'ignore',
    maxAge: '5m',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC_ROOT, 'admin.html')));
app.get('/produto/:uid', (_req, res) => res.sendFile(path.join(PUBLIC_ROOT, 'produto.html')));

// Fallback: só devolve a home para URLs sem extensão; arquivos inexistentes dão 404 de verdade
app.use((req, res) => {
  if (req.method === 'GET' && !path.extname(req.path)) {
    return res.sendFile(path.join(PUBLIC_ROOT, 'index.html'));
  }
  res.status(404).send('Não encontrado.');
});

// ==========================================
// TRATAMENTO DE ERROS
// ==========================================
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Imagem maior que 8 MB.' : 'Falha no envio do arquivo.';
    return res.status(400).json({ error: msg });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Requisição grande demais.' });
  }
  if (err instanceof ValidationError) {
    return res.status(400).json({ error: err.message, detail: err.message });
  }
  console.error('Erro não tratado:', err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

// ==========================================
// START
// ==========================================
ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`NIMARI server rodando na porta ${PORT} (frontend: ${PUBLIC_ROOT})`));
  })
  .catch((err) => {
    console.error('Falha ao preparar o banco de dados:', err);
    process.exit(1);
  });
