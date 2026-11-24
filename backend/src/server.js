const path = require('path');
const crypto = require('crypto');
const https = require('https');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_API_KEY = String(process.env.ADMIN_API_KEY || '').trim();
const JWT_SECRET = String(process.env.JWT_SECRET || ADMIN_API_KEY || 'nimari-dev-secret').trim();

const R2_ACCOUNT_ID = String(process.env.R2_ACCOUNT_ID || '').trim();
const R2_ACCESS_KEY_ID = String(process.env.R2_ACCESS_KEY_ID || '').trim();
const R2_SECRET_ACCESS_KEY = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_BUCKET_NAME = String(process.env.R2_BUCKET_NAME || 'nimari-midia').trim();
const R2_PUBLIC_URL = String(process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '');

// ==========================================
// CONEXÃO COM POSTGRESQL
// ==========================================
function buildPool() {
  const user = (process.env.POSTGRES_USER || process.env.DB_USER || '').trim();
  const password = process.env.POSTGRES_PASSWORD ?? process.env.DB_PASS ?? '';
  const database = (process.env.POSTGRES_DB || process.env.DB_NAME || 'railway').trim();

  const rawUrl = (
    process.env.DATABASE_URL ||
    process.env.DATABASE_PRIVATE_URL ||
    process.env.DATABASE_PUBLIC_URL ||
    process.env.POSTGRES_URL ||
    ''
  ).trim();

  const isValidProtocol = /^postgres(ql)?:\/\//i.test(rawUrl);

  if (isValidProtocol) {
    const isLocal = /localhost|127\.0\.0\.1|::1|\[::1\]/i.test(rawUrl);
    const ssl =
      process.env.DATABASE_SSL === 'false'
        ? false
        : process.env.DATABASE_SSL === 'true' || !isLocal
          ? { rejectUnauthorized: false }
          : false;

    return {
      pool: new Pool({ connectionString: rawUrl, ssl }),
      label: 'URL completa (postgres://)',
    };
  }

  let host = '';
  let port = Number(process.env.PGPORT || process.env.DB_PORT || 5432);

  if (rawUrl) {
    const hostPortMatch = rawUrl.match(/^([^/:]+)(?::(\d+))?$/);
    if (hostPortMatch) {
      host = hostPortMatch[1].trim();
      if (hostPortMatch[2]) {
        port = Number(hostPortMatch[2]);
      }
    }
  }

  if (!host) {
    const envHost = (process.env.PGHOST || process.env.DB_HOST || '').trim();
    if (envHost && !/^localhost$|^127\.0\.0\.1$|^::1$/i.test(envHost)) {
      host = envHost;
    } else if (envHost) {
      console.warn(
        `AVISO: host "${envHost}" ignorado porque aponta para localhost/loopback.`
      );
    }
  }

  if (host) {
    const isLocal = /^localhost$|^127\.0\.0\.1$|^::1$/i.test(host);
    const ssl =
      process.env.DATABASE_SSL === 'false'
        ? false
        : process.env.DATABASE_SSL === 'true' || !isLocal
          ? { rejectUnauthorized: false }
          : false;

    return {
      pool: new Pool({
        host,
        port: Number.isFinite(port) && port > 0 ? port : 5432,
        user: user || 'postgres',
        password,
        database,
        ssl,
      }),
      label: `host montado (${host}:${port})`,
    };
  }

  throw new Error(
    'Configuração de banco inválida: defina DATABASE_URL começando por postgres:// ou postgresql://, ou informe host/credenciais válidas sem localhost.'
  );
}

const { pool, label: dbLabel } = buildPool();

// ==========================================
// AUTENTICAÇÃO ADMIN (TOKEN ASSINADO COM HMAC)
// ==========================================
function signAdminToken() {
  const payload = Buffer.from(
    JSON.stringify({
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7,
    })
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(payload)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return false;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || data.role !== 'admin') return false;
    if (typeof data.exp === 'number' && Date.now() > data.exp) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function requireAdmin(req, res, next) {
  const authHeader = String(req.headers.authorization || '').trim();
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const apiKeyHeader = String(req.headers['x-admin-key'] || '').trim();

  if (verifyAdminToken(bearerToken)) {
    return next();
  }
  if (ADMIN_API_KEY && (bearerToken === ADMIN_API_KEY || apiKeyHeader === ADMIN_API_KEY)) {
    return next();
  }

  return res.status(401).json({ error: 'Não autorizado. Faça o login administrativo.' });
}

// ==========================================
// UPLOAD DE IMAGEM PARA CLOUDFLARE R2 (AWS V4)
// ==========================================
function parseMultipartSingleFile(req) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] || '');
    const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!match) return reject(new Error('Multipart boundary ausente.'));
    const boundary = match[1] || match[2];

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const boundaryBuf = Buffer.from(`--${boundary}`);
      let pos = body.indexOf(boundaryBuf);
      let pasta = 'produtos';
      let fileData = null;

      while (pos !== -1) {
        const start = pos + boundaryBuf.length;
        const nextPos = body.indexOf(boundaryBuf, start);
        if (nextPos === -1) break;

        const part = body.slice(start, nextPos);
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd !== -1) {
          const headersText = part.slice(0, headerEnd).toString('utf8');
          let content = part.slice(headerEnd + 4);
          if (content.slice(-2).equals(Buffer.from('\r\n'))) {
            content = content.slice(0, -2);
          }

          const filenameMatch = headersText.match(/filename="([^"]*)"/i);
          const nameMatch = headersText.match(/name="([^"]*)"/i);

          if (filenameMatch && filenameMatch[1]) {
            const typeMatch = headersText.match(/Content-Type:\s*([^\r\n]+)/i);
            fileData = {
              filename: filenameMatch[1],
              contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
              buffer: content,
            };
          } else if (nameMatch && nameMatch[1] === 'pasta') {
            const cleanFolder = content
              .toString('utf8')
              .trim()
              .replace(/[^a-zA-Z0-9_-]/g, '');
            if (cleanFolder) pasta = cleanFolder;
          }
        }
        pos = nextPos;
      }

      if (!fileData) {
        return reject(new Error('Nenhum arquivo enviado no campo file.'));
      }
      resolve({ ...fileData, pasta });
    });
    req.on('error', reject);
  });
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function uploadBufferToR2(key, buffer, contentType) {
  return new Promise((resolve, reject) => {
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
      return reject(new Error('Credenciais do Cloudflare R2 não configuradas nas variáveis.'));
    }

    const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const canonicalUri = `/${R2_BUCKET_NAME}/${key}`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const region = 'auto';
    const service = 's3';
    const payloadHash = sha256Hex(buffer);

    const canonicalHeaders =
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = [
      'PUT',
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
    ].join('\n');

    const kDate = hmacSha256(`AWS4${R2_SECRET_ACCESS_KEY}`, dateStamp);
    const kRegion = hmacSha256(kDate, region);
    const kService = hmacSha256(kRegion, service);
    const kSigning = hmacSha256(kService, 'aws4_request');
    const signature = crypto
      .createHmac('sha256', kSigning)
      .update(stringToSign)
      .digest('hex');

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const req = https.request(
      {
        hostname: host,
        port: 443,
        path: canonicalUri,
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Length': buffer.length,
          'x-amz-content-sha256': payloadHash,
          'x-amz-date': amzDate,
          Authorization: authorization,
        },
      },
      (res) => {
        const respChunks = [];
        res.on('data', (c) => respChunks.push(c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const publicBase = R2_PUBLIC_URL || `https://${host}/${R2_BUCKET_NAME}`;
            resolve(`${publicBase}/${key}`);
          } else {
            reject(
              new Error(
                `R2 respondeu HTTP ${res.statusCode}: ${Buffer.concat(respChunks).toString('utf8')}`
              )
            );
          }
        });
      }
    );

    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

// ==========================================
// MIDDLEWARES E ARQUIVOS ESTÁTICOS DO FRONTEND
// ==========================================
app.use(cors());
app.use(express.json({ limit: '15mb' }));

const PUBLIC_ROOT = path.resolve(__dirname, '..', '..');

app.use((req, res, next) => {
  const blocked = /^\/(backend|\.env|\.git|package(-lock)?\.json)/i;
  if (blocked.test(req.path)) {
    return res.status(404).end();
  }
  next();
});

app.use(express.static(PUBLIC_ROOT, { index: 'index.html' }));

function parsePriceValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
  }
  if (typeof value === 'string') {
    const cleaned = value
      .replace(/,/g, '.')
      .replace(/[^0-9.-]/g, '')
      .trim();
    if (!cleaned) return 0;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
  }
  return 0;
}

// Formata arrays para o tipo PostgreSQL correspondente (text[]/jsonb vs jsonb)
function formatPgArrayOrJson(val, udtName, dataType) {
  const arr = Array.isArray(val) ? val.filter((x) => x !== null && x !== undefined).map(String) : [];
  if (dataType === 'ARRAY' || String(udtName || '').startsWith('_')) {
    const escaped = arr.map((item) => `"${item.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    return `{${escaped.join(',')}}`;
  }
  return JSON.stringify(arr);
}

// ==========================================
// INICIALIZAÇÃO E REPARO DO SCHEMA DO BANCO
// ==========================================
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS produtos (
        id SERIAL PRIMARY KEY,
        uid TEXT,
        name TEXT NOT NULL,
        nome TEXT,
        descricao TEXT DEFAULT '',
        categoria TEXT DEFAULT 'cosmeticos',
        imagem TEXT DEFAULT '',
        imagens JSONB DEFAULT '[]'::jsonb,
        price TEXT,
        preco NUMERIC(12, 2) DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE produtos
        ADD COLUMN IF NOT EXISTS uid TEXT,
        ADD COLUMN IF NOT EXISTS name TEXT,
        ADD COLUMN IF NOT EXISTS nome TEXT,
        ADD COLUMN IF NOT EXISTS descricao TEXT DEFAULT '',
        ADD COLUMN IF NOT EXISTS categoria TEXT DEFAULT 'cosmeticos',
        ADD COLUMN IF NOT EXISTS imagem TEXT DEFAULT '',
        ADD COLUMN IF NOT EXISTS imagens JSONB DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS price TEXT,
        ADD COLUMN IF NOT EXISTS preco NUMERIC(12, 2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
    `);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'produtos' AND column_name = 'uid'
        ) THEN
          UPDATE produtos
          SET uid = 'prod-' || id::text || '-' || substr(md5(random()::text), 1, 8)
          WHERE uid IS NULL OR TRIM(uid) = '';

          ALTER TABLE produtos
            ALTER COLUMN uid DROP NOT NULL;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'produtos' AND column_name = 'name'
        ) AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'produtos' AND column_name = 'nome'
        ) THEN
          UPDATE produtos
          SET name = COALESCE(NULLIF(TRIM(name), ''), NULLIF(TRIM(nome), ''), 'Produto'),
              nome = COALESCE(NULLIF(TRIM(nome), ''), NULLIF(TRIM(name), ''), 'Produto');
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'produtos'
            AND column_name = 'preco'
        ) THEN
          IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'produtos'
              AND column_name = 'price'
          ) THEN
            UPDATE produtos
            SET preco = COALESCE(
              preco,
              NULLIF(
                regexp_replace(
                  replace(COALESCE(price::text, ''), ',', '.'),
                  '[^0-9.-]',
                  '',
                  'g'
                ),
                ''
              )::numeric,
              0::numeric
            )
            WHERE preco IS NULL;
          ELSE
            UPDATE produtos
            SET preco = 0::numeric
            WHERE preco IS NULL;
          END IF;

          ALTER TABLE produtos
            ALTER COLUMN preco TYPE NUMERIC(12, 2)
            USING COALESCE(preco, 0::numeric),
            ALTER COLUMN preco SET DEFAULT 0,
            ALTER COLUMN preco SET NOT NULL;
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS loja_config (
        id INTEGER PRIMARY KEY DEFAULT 1,
        wpp_number TEXT DEFAULT '',
        about_image TEXT DEFAULT '',
        hidden_categories JSONB DEFAULT '[]'::jsonb,
        brands JSONB DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      INSERT INTO loja_config (id, wpp_number, about_image, hidden_categories, brands)
      VALUES (1, '', '', '[]'::jsonb, '[]'::jsonb)
      ON CONFLICT (id) DO NOTHING;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS depoimentos (
        id SERIAL PRIMARY KEY,
        autor TEXT NOT NULL,
        mensagem TEXT NOT NULL,
        avaliacao INTEGER DEFAULT 5,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ==========================================
// ROTAS DE SAÚDE E AUTENTICAÇÃO
// ==========================================
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const password = String(req.body?.password || '').trim();

  if (!ADMIN_API_KEY) {
    return res.status(500).json({
      error: 'ADMIN_API_KEY não configurada no servidor.',
    });
  }

  if (!password) {
    return res.status(400).json({ error: 'Digite a senha de acesso.' });
  }

  if (password !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Senha incorreta. Tente novamente.' });
  }

  const token = signAdminToken();
  return res.status(200).json({ ok: true, token });
});

// ==========================================
// ROTAS DE CONFIGURAÇÃO E DEPOIMENTOS
// ==========================================
app.get('/api/config', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM loja_config WHERE id = 1');
    const row = result.rows[0] || {};
    res.json({
      wppNumber: row.wpp_number || process.env.WPP_NUMBER || '',
      aboutImage: row.about_image || '',
      hiddenCategories: Array.isArray(row.hidden_categories) ? row.hidden_categories : [],
      brands: Array.isArray(row.brands) ? row.brands : [],
    });
  } catch (err) {
    console.error('Erro ao buscar config:', err);
    res.status(500).json({ error: 'Erro ao carregar configurações.' });
  }
});

app.put('/api/config', requireAdmin, async (req, res) => {
  try {
    const { wppNumber, aboutImage, hiddenCategories, brands } = req.body || {};
    const hiddenArr = Array.isArray(hiddenCategories) ? hiddenCategories : [];
    const brandsArr = Array.isArray(brands) ? brands : [];

    const result = await pool.query(
      `UPDATE loja_config
       SET wpp_number = COALESCE($1, wpp_number),
           about_image = COALESCE($2, about_image),
           hidden_categories = $3::jsonb,
           brands = $4::jsonb,
           updated_at = NOW()
       WHERE id = 1
       RETURNING *`,
      [
        wppNumber !== undefined ? String(wppNumber) : null,
        aboutImage !== undefined ? String(aboutImage) : null,
        JSON.stringify(hiddenArr),
        JSON.stringify(brandsArr),
      ]
    );

    const row = result.rows[0] || {};
    res.json({
      wppNumber: row.wpp_number || '',
      aboutImage: row.about_image || '',
      hiddenCategories: Array.isArray(row.hidden_categories) ? row.hidden_categories : [],
      brands: Array.isArray(row.brands) ? row.brands : [],
    });
  } catch (err) {
    console.error('Erro ao salvar config:', err);
    res.status(500).json({ error: 'Erro ao salvar configurações.' });
  }
});

app.get('/api/depoimentos', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM depoimentos ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar depoimentos:', err);
    res.status(500).json({ error: 'Erro ao carregar depoimentos.' });
  }
});

// ==========================================
// ROTA DE UPLOAD (CLOUDFLARE R2)
// ==========================================
app.post('/api/upload', requireAdmin, async (req, res) => {
  try {
    const file = await parseMultipartSingleFile(req);
    const extMatch = String(file.filename || '').match(/\.(png|jpe?g|webp|gif)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
    const key = `${file.pasta}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const url = await uploadBufferToR2(key, file.buffer, file.contentType);
    return res.status(200).json({ ok: true, url, key });
  } catch (err) {
    console.error('Erro no upload R2:', err);
    return res.status(500).json({ error: err.message || 'Falha no upload de imagem.' });
  }
});

// ==========================================
// ROTAS DE PRODUTOS
// ==========================================
app.get('/api/produtos', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM produtos ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar produtos:', err);
    res.status(500).json({ error: 'Erro interno ao buscar produtos.' });
  }
});

app.post('/api/produtos', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const nomeFinal = String(body.name ?? body.nome ?? '').trim();
    if (!nomeFinal) {
      return res.status(400).json({ error: 'O nome do produto é obrigatório.' });
    }

    const uidFinal = String(body.uid || '').trim() || `prod-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    const rawPriceInput =
      body.preco !== undefined && body.preco !== null && String(body.preco).trim() !== ''
        ? body.preco
        : body.price;

    const precoNormalizado = parsePriceValue(rawPriceInput);
    const priceTexto =
      rawPriceInput !== undefined && rawPriceInput !== null && String(rawPriceInput).trim() !== ''
        ? String(rawPriceInput)
        : precoNormalizado.toFixed(2).replace('.', ',');

    const categoria = String(body.categoria || 'cosmeticos').trim() || 'cosmeticos';
    const descricao = String(body.descricao || '').trim();
    const imagensArr = Array.isArray(body.imagens)
      ? body.imagens.filter(Boolean)
      : body.imagem
        ? [String(body.imagem)]
        : [];
    const imagemPrincipal = String(body.imagem || imagensArr[0] || '').trim();

    const colsRes = await pool.query(`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'produtos'
    `);
    const colMeta = new Map(colsRes.rows.map((r) => [r.column_name, r]));

    const insertCols = [];
    const insertVals = [];
    const placeholders = [];

    const pushCol = (col, val, isArrayField = false) => {
      const meta = colMeta.get(col);
      if (!meta) return;

      let formattedVal = val;
      if (isArrayField) {
        formattedVal = formatPgArrayOrJson(val, meta.udt_name, meta.data_type);
      }

      insertCols.push(col);
      insertVals.push(formattedVal);
      const cast = !isArrayField && meta.udt_name === 'jsonb' ? '::jsonb' : '';
      placeholders.push(`$${insertVals.length}${cast}`);
    };

    pushCol('uid', uidFinal);
    pushCol('name', nomeFinal);
    pushCol('nome', nomeFinal);
    pushCol('descricao', descricao);
    pushCol('categoria', categoria);
    pushCol('imagem', imagemPrincipal);
    pushCol('imagens', imagensArr, true);
    pushCol('price', priceTexto);
    pushCol('preco', precoNormalizado);

    if (insertCols.length === 0) {
      throw new Error('Tabela produtos sem colunas compatíveis.');
    }

    const result = await pool.query(
      `INSERT INTO produtos (${insertCols.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING *`,
      insertVals
    );

    const created = result.rows[0];
    res.status(201).json({
      ...created,
      name: created.name || created.nome || nomeFinal,
      nome: created.nome || created.name || nomeFinal,
    });
  } catch (err) {
    console.error('Erro ao criar produto:', err);
    res.status(500).json({
      error: 'Erro interno ao criar produto.',
      detail: err.message,
    });
  }
});

// ==========================================
// PÁGINAS HTML DA LOJA NIMARI
// ==========================================
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_ROOT, 'index.html'));
});

app.get('/produto', (_req, res) => {
  res.sendFile(path.join(PUBLIC_ROOT, 'produto.html'));
});

async function startServer() {
  await initDatabase();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor ativo na porta ${PORT} (${dbLabel})`);
  });
}

startServer().catch((err) => {
  console.error('Falha no arranque:', err);
  process.exit(1);
});
