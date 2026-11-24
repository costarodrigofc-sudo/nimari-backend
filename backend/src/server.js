const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

function buildPool() {
  const connectionString =
    process.env.DATABASE_URL ||
    process.env.DATABASE_PRIVATE_URL ||
    process.env.DATABASE_PUBLIC_URL ||
    process.env.POSTGRES_URL;

  if (connectionString && connectionString.trim() !== '') {
    const trimmed = connectionString.trim();
    const isLocal =
      trimmed.includes('localhost') ||
      trimmed.includes('127.0.0.1') ||
      trimmed.includes('::1');

    const ssl =
      process.env.DATABASE_SSL === 'false'
        ? false
        : process.env.DATABASE_SSL === 'true' || !isLocal
          ? { rejectUnauthorized: false }
          : false;

    return {
      pool: new Pool({ connectionString: trimmed, ssl }),
      label: 'connectionString',
    };
  }

  if (process.env.PGHOST && process.env.PGHOST.trim() !== '') {
    const host = process.env.PGHOST.trim();
    const isLocal =
      host === 'localhost' || host === '127.0.0.1' || host === '::1';

    const ssl =
      process.env.DATABASE_SSL === 'false'
        ? false
        : process.env.DATABASE_SSL === 'true' || !isLocal
          ? { rejectUnauthorized: false }
          : false;

    return {
      pool: new Pool({
        host,
        port: Number(process.env.PGPORT || 5432),
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE || 'railway',
        ssl,
      }),
      label: `${host}:${process.env.PGPORT || 5432}`,
    };
  }

  throw new Error(
    'Variável de conexão com o PostgreSQL ausente (defina DATABASE_URL ou PGHOST nas variáveis do serviço na Railway).'
  );
}

const { pool, label: dbLabel } = buildPool();

app.use(cors());
app.use(express.json());

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