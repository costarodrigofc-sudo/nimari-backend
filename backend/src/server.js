const path = require('path');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Monta o Pool do PostgreSQL com segurança:
 * 1. Só usa connectionString se começar por postgres:// ou postgresql://.
 * 2. Se vier apenas host:porta (ex.: kodama.proxy.rlwy.net:56955), extrai o host e a porta
 *    e monta a conexão usando POSTGRES_USER/DB_USER, POSTGRES_PASSWORD/DB_PASS e POSTGRES_DB/DB_NAME.
 * 3. Nunca cai em localhost se houver credenciais/host válidos; se faltar configuração válida, lança erro explícito.
 */
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

app.use(cors());
app.use(express.json());

// Caminho para a raiz do projeto onde estão index.html, produto.html, app.js, styles.css e favicon_io
const PUBLIC_ROOT = path.resolve(__dirname, '..', '..');

// Bloqueia acesso direto a ficheiros sensíveis ou pastas internas do backend
app.use((req, res, next) => {
  const blocked = /^\/(backend|\.env|\.git|package(-lock)?\.json)/i;
  if (blocked.test(req.path)) {
    return res.status(404).end();
  }
  next();
});

// Serve os ficheiros estáticos do frontend da NIMARI (index.html, produto.html, app.js, styles.css, favicon_io)
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

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS produtos (
        id SERIAL PRIMARY KEY,
        uid TEXT,
        name TEXT NOT NULL,
        descricao TEXT DEFAULT '',
        price TEXT,
        preco NUMERIC(12, 2) DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'produtos'
            AND column_name = 'preco'
        ) THEN
          ALTER TABLE produtos ADD COLUMN preco NUMERIC(12, 2);
        END IF;

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
      END $$;
    `);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/produtos', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM produtos ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar produtos:', err);
    res.status(500).json({ error: 'Erro interno ao buscar produtos.' });
  }
});

app.post('/api/produtos', async (req, res) => {
  try {
    const { uid, name, descricao, price, preco } = req.body;
    const precoNormalizado = parsePriceValue(
      preco !== undefined && preco !== null && preco !== '' ? preco : price
    );
    const priceTexto =
      price !== undefined && price !== null
        ? String(price)
        : precoNormalizado.toFixed(2).replace('.', ',');

    const result = await pool.query(
      `INSERT INTO produtos (uid, name, descricao, price, preco)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [uid || null, name, descricao || '', priceTexto, precoNormalizado]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao criar produto:', err);
    res.status(500).json({ error: 'Erro interno ao criar produto.' });
  }
});

// Rotas explícitas das páginas HTML da loja NIMARI
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