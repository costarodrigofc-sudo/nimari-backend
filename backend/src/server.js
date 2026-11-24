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

const PUBLIC_ROOT = path.resolve(__dirname, '../..');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const JWT_SECRET = String(process.env.JWT_SECRET || ADMIN_PASSWORD || 'nimari-secret-2026').trim();

// ==========================================
// CONEXÃO POSTGRESQL (RAILWAY)
// ==========================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

// ==========================================
// CLOUDFLARE R2 (OPCIONAL SE VARIÁVEIS DEFINIDAS)
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
        credentials: {
          accessKeyId: R2_ACCESS_KEY_ID,
          secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
      })
    : null;

// ==========================================
// MIDDLEWARES GERAIS
// ==========================================
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(PUBLIC_ROOT));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

// ==========================================
// AUTENTICAÇÃO ADMIN (TOKEN ASSINADO HMAC)
// ==========================================
function signAdminToken(payloadObj) {
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(payloadB64).digest('base64url');
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const session = verifyAdminToken(token);
  if (!session) {
    return res.status(401).json({ error: 'Sessão administrativa inválida ou expirada.' });
  }
  req.admin = session;
  next();
}

app.post('/api/auth/login', (req, res) => {
  const pwd = String(req.body && req.body.password ? req.body.password : '').trim();
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD não configurada no servidor.' });
  }
  if (!pwd || pwd !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }
  const token = signAdminToken({
    role: 'admin',
    iat: Date.now(),
    exp: Date.now() + 12 * 60 * 60 * 1000,
  });
  res.json({ ok: true, token });
});

// ==========================================
// HELPERS DE NORMALIZAÇÃO DE PRODUTO
// ==========================================
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

function generateSku(providedSku) {
  const clean = String(providedSku || '').trim().toUpperCase();
  if (clean) return clean.slice(0, 64);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `NIM-${stamp}-${rand}`;
}

function sanitizeProductPayload(body) {
  const b = body && typeof body === 'object' ? body : {};
  const nome = String(b.nome !== undefined ? b.nome : b.name !== undefined ? b.name : '').trim();
  if (!nome) {
    throw new Error('O nome do produto é obrigatório.');
  }

  const sku = generateSku(b.sku);
  const descricao = String(b.descricao !== undefined ? b.descricao : '').trim();
  const categoria = normalizeCategory(b.categoria);
  const subcategoria = String(b.subcategoria !== undefined ? b.subcategoria : '').trim();
  const marca = String(b.marca !== undefined ? b.marca : '').trim();
  const preco = parsePrice(b.preco !== undefined ? b.preco : b.price !== undefined ? b.price : 0);

  const rawOld = b.preco_antigo !== undefined ? b.preco_antigo : b.priceOld;
  const parsedOld =
    rawOld !== undefined && rawOld !== null && String(rawOld).trim() !== ''
      ? parsePrice(rawOld)
      : null;
  const preco_antigo = parsedOld && parsedOld > preco ? parsedOld : null;

  const allowedBadges = new Set(['none', 'novo', 'oferta', 'vendido', 'esgotado']);
  const badgeRaw = String(b.badge || 'none').trim().toLowerCase();
  const badge = allowedBadges.has(badgeRaw) ? badgeRaw : 'none';

  const imagensList = Array.isArray(b.imagens)
    ? b.imagens.map((u) => String(u || '').trim()).filter(Boolean)
    : [];
  const imagem = String(b.imagem || imagensList[0] || '').trim();
  const imagens = imagem
    ? [imagem].concat(imagensList.filter((u) => u !== imagem))
    : imagensList;

  const ativo = b.ativo === false ? false : true;

  return {
    sku,
    nome,
    descricao,
    categoria,
    subcategoria,
    marca,
    preco,
    preco_antigo,
    badge,
    imagem,
    imagens,
    ativo,
  };
}

// ==========================================
// ROTAS DE PRODUTOS (VITRINE + ADMIN)
// ==========================================
app.get('/api/produtos', async (req, res) => {
  try {
    const includeInactive = req.query.all === '1';
    const sql = includeInactive
      ? 'SELECT * FROM produtos ORDER BY id DESC'
      : 'SELECT * FROM produtos WHERE ativo = TRUE ORDER BY id DESC';
    const result = await pool.query(sql);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao listar produtos:', err);
    res.status(500).json({ error: 'Erro ao listar produtos.' });
  }
});

app.post('/api/produtos', requireAdmin, async (req, res) => {
  try {
    const p = sanitizeProductPayload(req.body);
    const result = await pool.query(
      `INSERT INTO produtos
        (sku, nome, descricao, categoria, subcategoria, marca, preco, preco_antigo, badge, imagem, imagens, ativo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
       RETURNING *`,
      [
        p.sku,
        p.nome,
        p.descricao,
        p.categoria,
        p.subcategoria,
        p.marca,
        p.preco,
        p.preco_antigo,
        p.badge,
        p.imagem,
        JSON.stringify(p.imagens),
        p.ativo,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao cadastrar produto:', err);
    res.status(400).json({ error: 'Falha ao cadastrar produto.', detail: err.message });
  }
});

app.post('/api/produtos/batch', requireAdmin, async (req, res) => {
  const list = req.body && Array.isArray(req.body.produtos) ? req.body.produtos : [];
  if (list.length === 0) {
    return res.status(400).json({ error: 'Envie uma lista em "produtos" para importar em lote.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = [];

    for (let i = 0; i < list.length; i += 1) {
      const p = sanitizeProductPayload(list[i]);
      const r = await client.query(
        `INSERT INTO produtos
          (sku, nome, descricao, categoria, subcategoria, marca, preco, preco_antigo, badge, imagem, imagens, ativo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
         ON CONFLICT (sku) DO UPDATE SET
           nome = EXCLUDED.nome,
           descricao = EXCLUDED.descricao,
           categoria = EXCLUDED.categoria,
           subcategoria = EXCLUDED.subcategoria,
           marca = EXCLUDED.marca,
           preco = EXCLUDED.preco,
           preco_antigo = EXCLUDED.preco_antigo,
           badge = EXCLUDED.badge,
           imagem = CASE WHEN EXCLUDED.imagem <> '' THEN EXCLUDED.imagem ELSE produtos.imagem END,
           imagens = CASE WHEN jsonb_array_length(EXCLUDED.imagens) > 0 THEN EXCLUDED.imagens ELSE produtos.imagens END,
           ativo = EXCLUDED.ativo,
           updated_at = NOW()
         RETURNING *`,
        [
          p.sku,
          p.nome,
          p.descricao,
          p.categoria,
          p.subcategoria,
          p.marca,
          p.preco,
          p.preco_antigo,
          p.badge,
          p.imagem,
          JSON.stringify(p.imagens),
          p.ativo,
        ]
      );
      inserted.push(r.rows[0]);
    }

    await client.query('COMMIT');
    res.status(201).json({ ok: true, count: inserted.length, produtos: inserted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro na importação em lote:', err);
    res.status(400).json({ error: 'Falha na importação em lote.', detail: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/produtos/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  try {
    const p = sanitizeProductPayload(req.body);
    const result = await pool.query(
      `UPDATE produtos
       SET sku = $1,
           nome = $2,
           descricao = $3,
           categoria = $4,
           subcategoria = $5,
           marca = $6,
           preco = $7,
           preco_antigo = $8,
           badge = $9,
           imagem = $10,
           imagens = $11::jsonb,
           ativo = $12,
           updated_at = NOW()
       WHERE id = $13
       RETURNING *`,
      [
        p.sku,
        p.nome,
        p.descricao,
        p.categoria,
        p.subcategoria,
        p.marca,
        p.preco,
        p.preco_antigo,
        p.badge,
        p.imagem,
        JSON.stringify(p.imagens),
        p.ativo,
        id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao editar produto:', err);
    res.status(400).json({ error: 'Falha ao atualizar produto.', detail: err.message });
  }
});

app.delete('/api/produtos/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  try {
    const result = await pool.query('DELETE FROM produtos WHERE id = $1 RETURNING id', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }
    res.json({ ok: true, deletedId: id });
  } catch (err) {
    console.error('Erro ao excluir produto:', err);
    res.status(500).json({ error: 'Erro ao excluir produto.' });
  }
});

// ==========================================
// UPLOAD DE IMAGEM -> WEBP NO CLOUDFLARE R2
// ==========================================
app.post('/api/upload', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }
    if (!r2Client || !R2_BUCKET_NAME || !R2_PUBLIC_URL) {
      return res.status(500).json({ error: 'Cloudflare R2 não configurado nas variáveis de ambiente.' });
    }

    const pasta = String(req.body && req.body.pasta ? req.body.pasta : 'produtos').replace(/[^a-z0-9_-]/gi, '') || 'produtos';
    const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.webp`;
    const key = `${pasta}/${filename}`;

    const webpBuffer = await sharp(req.file.buffer)
      .rotate()
      .resize({ width: 1200, withoutEnlargement: true })
      .webp({ quality: 84 })
      .toBuffer();

    await r2Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: webpBuffer,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000',
      })
    );

    res.json({ ok: true, key, url: `${R2_PUBLIC_URL}/${key}` });
  } catch (err) {
    console.error('Erro no upload R2:', err);
    res.status(500).json({ error: 'Falha ao processar upload.', detail: err.message });
  }
});

// ==========================================
// CONFIG & DEPOIMENTOS (FALLBACK SEGURO)
// ==========================================
app.get('/api/config', async (_req, res) => {
  res.json({
    wppNumber: process.env.WPP_NUMBER || '5598985631126',
    aboutImage: '',
    hiddenCategories: [],
    brands: [],
  });
});

app.get('/api/depoimentos', async (_req, res) => {
  res.json([]);
});

// ==========================================
// ROTAS DE PÁGINAS
// ==========================================
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(PUBLIC_ROOT, 'admin.html'));
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_ROOT, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`NIMARI server rodando na porta ${PORT}`);
});