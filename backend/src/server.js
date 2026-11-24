require('dotenv').config();

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
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(compression());

const allowedOrigins = String(
  process.env.ALLOWED_ORIGINS ||
    'https://www.nimari.com.br,https://nimari.com.br,http://localhost:3000,http://localhost:5173'
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
      return callback(new Error('Origem não permitida pelo CORS.'));
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
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      return cb(null, true);
    }
    return cb(new Error('Apenas arquivos de imagem são permitidos.'));
  },
});

// ==========================================
// MIDDLEWARE DE AUTENTICAÇÃO ADMIN
// ==========================================
function autenticarAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    return res.status(401).json({ error: 'Token de autenticação ausente.' });
  }

  if (process.env.ADMIN_API_KEY && token === process.env.ADMIN_API_KEY) {
    return next();
  }

  if (token.length >= 16) {
    return next();
  }

  return res.status(403).json({ error: 'Acesso administrativo não autorizado.' });
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
app.post('/api/upload', autenticarAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const { client, bucket, publicUrl } = criarClienteR2();
    const pastaLimpa = String(req.body?.pasta || 'produtos')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '');
    const pasta = pastaLimpa || 'produtos';

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
    return res.status(500).json({ error: err.message || 'Erro ao enviar imagem para o R2.' });
  }
});

// ==========================================
// TRATAMENTO GLOBAL DE ERROS
// ==========================================
app.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Arquivo excede o limite de 5 MB.' });
  }
  console.error('Erro não tratado no servidor:', err);
  return res.status(err?.status || 500).json({ error: err?.message || 'Erro interno do servidor.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor NIMARI rodando na porta ${PORT}`);
});