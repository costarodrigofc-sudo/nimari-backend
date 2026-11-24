require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const sharp = require('sharp');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

sharp.cache(false);
sharp.concurrency(1);

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

function getArgValue(prefix) {
  const found = args.find((a) => a.startsWith(`${prefix}=`));
  return found ? found.slice(prefix.length + 1) : '';
}

const cliDbUrl = getArgValue('--db-url');
const cliHost = getArgValue('--host');
const cliPort = getArgValue('--port');
const cliPass = getArgValue('--pass');

const dbUrl = cliDbUrl || process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL || '';

function buildPoolConfig() {
  if (dbUrl && !dbUrl.includes('${{')) {
    const useSsl = dbUrl.includes('rlwy.net') || dbUrl.includes('railway') || process.env.NODE_ENV === 'production';
    return {
      connectionString: dbUrl,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
    };
  }

  const host = cliHost || process.env.DB_HOST;
  const port = Number(cliPort || process.env.DB_PORT || 5432);
  const database = process.env.DB_NAME || 'railway';
  const user = process.env.DB_USER || 'postgres';
  const password = cliPass || process.env.DB_PASS;

  if (!host || host.includes('${{') || !password || password.includes('${{')) {
    console.error('❌ Conexão com PostgreSQL não resolvida.');
    console.error('👉 No Console do Railway, basta rodar: node scripts/migrar_supabase_para_r2.js');
    console.error('👉 No seu PC com proxy público, rode: node scripts/migrar_supabase_para_r2.js --db-url="postgresql://postgres:SENHA@HOST.proxy.rlwy.net:PORTA/railway"');
    process.exit(1);
  }

  const useSsl = host.includes('rlwy.net') || host.includes('railway') || process.env.NODE_ENV === 'production';
  return {
    host,
    port,
    database,
    user,
    password,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  };
}

const requiredR2 = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_PUBLIC_URL',
];

for (const key of requiredR2) {
  if (!process.env[key] || String(process.env[key]).includes('COLE_AQUI')) {
    console.error(`❌ Variável R2 obrigatória ausente ou não preenchida: ${key}`);
    process.exit(1);
  }
}

const pool = new Pool(buildPoolConfig());

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const r2BaseUrl = process.env.R2_PUBLIC_URL.replace(/\/$/, '');
const urlCache = new Map();

function toSlug(text) {
  return (
    String(text || 'item')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  );
}

function isSupabaseUrl(url) {
  return typeof url === 'string' && url.includes('supabase.co');
}

async function migrateSingleUrl(oldUrl, folder, prefixSlug, index) {
  if (!isSupabaseUrl(oldUrl)) return oldUrl;
  if (urlCache.has(oldUrl)) return urlCache.get(oldUrl);

  const fileName = `${folder}/${prefixSlug}-${index}-${Date.now()}.webp`;
  const newUrl = `${r2BaseUrl}/${fileName}`;

  if (DRY_RUN) {
    console.log(`🧪 [DRY-RUN] ${oldUrl} -> ${newUrl}`);
    urlCache.set(oldUrl, newUrl);
    return newUrl;
  }

  const res = await fetch(oldUrl);
  if (!res.ok) {
    throw new Error(`Falha ao baixar imagem (${res.status}): ${oldUrl}`);
  }

  const inputBuffer = Buffer.from(await res.arrayBuffer());

  const webpBuffer = await sharp(inputBuffer)
    .rotate()
    .resize({ width: 1200, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: webpBuffer,
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );

  urlCache.set(oldUrl, newUrl);
  console.log(`✅ Migrado: ${oldUrl} -> ${newUrl}`);
  return newUrl;
}

async function run() {
  console.log(DRY_RUN ? '🧪 Simulação (--dry-run)...' : '🚀 Iniciando migração Supabase -> R2 (WebP)...');

  // 1. Produtos
  const { rows: produtos } = await pool.query('SELECT id, uid, name, img, imagens FROM produtos');
  let prodCount = 0;

  for (const prod of produtos) {
    const slug = toSlug(prod.name || prod.uid || `produto-${prod.id}`);
    let changed = false;
    let nextImg = prod.img || '';

    if (isSupabaseUrl(nextImg)) {
      nextImg = await migrateSingleUrl(nextImg, 'produtos', slug, 1);
      changed = true;
    }

    const galeriaAtual = Array.isArray(prod.imagens) ? prod.imagens : [];
    const nextGaleria = [];

    for (let i = 0; i < galeriaAtual.length; i++) {
      const itemUrl = galeriaAtual[i];
      if (isSupabaseUrl(itemUrl)) {
        nextGaleria.push(await migrateSingleUrl(itemUrl, 'produtos', slug, i + 2));
        changed = true;
      } else {
        nextGaleria.push(itemUrl);
      }
    }

    if (changed) {
      if (!DRY_RUN) {
        await pool.query(
          'UPDATE produtos SET img = $1, imagens = $2, updated_at = NOW() WHERE id = $3',
          [nextImg, nextGaleria, prod.id]
        );
      }
      prodCount++;
    }
  }

  // 2. Marcas
  const { rows: marcas } = await pool.query('SELECT id, nome, logo_url FROM marcas');
  for (const m of marcas) {
    if (isSupabaseUrl(m.logo_url)) {
      const nextLogo = await migrateSingleUrl(m.logo_url, 'marcas', toSlug(m.nome), 1);
      if (!DRY_RUN) {
        await pool.query('UPDATE marcas SET logo_url = $1 WHERE id = $2', [nextLogo, m.id]);
      }
    }
  }

  // 3. Depoimentos
  const { rows: depos } = await pool.query('SELECT id, nome, avatar FROM depoimentos');
  for (const d of depos) {
    if (isSupabaseUrl(d.avatar)) {
      const nextAvatar = await migrateSingleUrl(d.avatar, 'depoimentos', toSlug(d.nome), 1);
      if (!DRY_RUN) {
        await pool.query('UPDATE depoimentos SET avatar = $1 WHERE id = $2', [nextAvatar, d.id]);
      }
    }
  }

  // 4. Configurações
  const { rows: configs } = await pool.query('SELECT chave, valor FROM configuracoes');
  for (const c of configs) {
    if (isSupabaseUrl(c.valor)) {
      const nextVal = await migrateSingleUrl(c.valor, 'config', toSlug(c.chave), 1);
      if (!DRY_RUN) {
        await pool.query('UPDATE configuracoes SET valor = $1, updated_at = NOW() WHERE chave = $2', [nextVal, c.chave]);
      }
    }
  }

  const outPath = path.join(__dirname, 'mapa_migracao_r2.json');
  fs.writeFileSync(outPath, JSON.stringify(Object.fromEntries(urlCache.entries()), null, 2), 'utf8');

  console.log(`🏁 Finalizado! Produtos atualizados: ${prodCount} | Total de imagens migradas: ${urlCache.size}`);
  console.log(`📄 Mapa salvo em: ${outPath}`);
  await pool.end();
}

run().catch(async (err) => {
  console.error('❌ Erro na migração:', err);
  await pool.end();
  process.exit(1);
});
