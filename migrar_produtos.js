// ══════════════════════════════════════════════
//  SCRIPT DE MIGRAÇÃO — Produtos Estáticos → BD
//  Execute: node migrar_produtos.js
// ══════════════════════════════════════════════
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
});

const produtos = require('./produtos_migracao.json');

async function migrar() {
  console.log(`\n🔄 Iniciando migração de ${produtos.length} produtos...\n`);
  let inseridos = 0;
  let ignorados = 0;

  for (const p of produtos) {
    try {
      const { rowCount } = await pool.query(
        `INSERT INTO produtos (uid, name, descricao, price, price_old, img, badge, cat, sub, wpp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (uid) DO NOTHING`,
        [p.uid, p.name, p.descricao, p.price, p.price_old, p.img, p.badge, p.cat, p.sub, p.wpp]
      );
      if (rowCount > 0) {
        inseridos++;
        console.log(`✅ Inserido: ${p.name.substring(0, 60)}...`);
      } else {
        ignorados++;
        console.log(`⏭️  Já existe: ${p.name.substring(0, 60)}...`);
      }
    } catch (err) {
      console.error(`❌ Erro em "${p.name}": ${err.message}`);
    }
  }

  console.log(`\n══════════════════════════════════`);
  console.log(`✅ Inseridos:  ${inseridos}`);
  console.log(`⏭️  Ignorados: ${ignorados}`);
  console.log(`══════════════════════════════════\n`);
  await pool.end();
}

migrar();
