require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
});

p.query(`
  DELETE FROM produtos
  WHERE uid NOT IN (
    SELECT DISTINCT ON (name) uid
    FROM produtos
    WHERE ativo = TRUE
      AND name NOT IN ('aaa','aaaa','qewqeqe','oeiwio','daskdalksd')
    ORDER BY name, criado_em DESC
  )
`).then(r => {
  console.log('Deletados:', r.rowCount, 'registros duplicados/lixo');
  return p.query('SELECT COUNT(*) FROM produtos WHERE ativo=TRUE');
}).then(r => {
  console.log('Produtos restantes:', r.rows[0].count);
  p.end();
}).catch(e => { console.error(e); p.end(); });