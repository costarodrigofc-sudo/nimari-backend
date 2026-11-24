const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

function resolveDatabaseConfig() {
  const connectionString =
    process.env.DATABASE_URL ||
    process.env.DATABASE_PRIVATE_URL ||
    process.env.POSTGRES_URL ||
    '';

  const useSsl =
    process.env.DATABASE_SSL === 'false'
      ? false
      : process.env.DATABASE_SSL === 'true' ||
          process.env.NODE_ENV === 'production' ||
          Boolean(connectionString && !connectionString.includes('localhost') && !connectionString.includes('127.0.0.1'));

  const sslConfig = useSsl ? { rejectUnauthorized: false } : false;

  if (connectionString) {
    return {
      source: process.env.DATABASE_URL
        ? 'DATABASE_URL'
        : process.env.DATABASE_PRIVATE_URL
          ? 'DATABASE_PRIVATE_URL'
          : 'POSTGRES_URL',
      poolConfig: {
        connectionString,
        ssl: sslConfig,
      },
    };
  }

  if (process.env.PGHOST) {
    return {
      source: 'PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE',
      poolConfig: {
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT || 5432),
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE || 'railway',
        ssl: sslConfig,
      },
    };
  }

  return {
    source: 'fallback_localhost',
    poolConfig: {
      host: '127.0.0.1',
      port: 5432,
      user: 'postgres',
      password: process.env.PGPASSWORD || '',
      database: process.env.PGDATABASE || 'railway',
      ssl: false,
    },
  };
}

const dbConfig = resolveDatabaseConfig();
const pool = new Pool(dbConfig.poolConfig);

app.use(cors());
app.use(express.json());

/**
 * Converte valores textuais ou numéricos (incluindo vírgula decimal ex: "215,00")
 * para número seguro em JavaScript.
 */
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

/**
 * Inicializa o schema e migra/normaliza a tabela produtos sem erro
 * COALESCE types numeric and text cannot be matched (42804).
 */
async function initDatabase() {
  if (dbConfig.source === 'fallback_localhost') {
    console.warn(
      'AVISO: Nenhuma variável de base de dados (DATABASE_URL, DATABASE_PRIVATE_URL ou PGHOST) foi encontrada no ambiente. A tentar 127.0.0.1:5432.'
    );
  } else {
    console.log(`A ligar ao PostgreSQL via ${dbConfig.source}...`);
  }

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
    console.log('Banco de dados inicializado e tabela produtos normalizada com sucesso.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao inicializar o banco de dados:', err);
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
  try {
    await initDatabase();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Servidor rodando na porta ${PORT}`);
    });
  } catch (err) {
    console.error('Falha crítica no arranque do servidor:', err);
    process.exit(1);
  }
}

startServer();