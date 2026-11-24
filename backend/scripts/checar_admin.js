require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
});

p.query('SELECT id, username FROM admin_users').then(r => {
  console.log('Admins cadastrados:', r.rows);
  p.end();
}).catch(e => { console.error(e); p.end(); });