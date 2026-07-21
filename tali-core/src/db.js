const { Pool } = require('pg');

// Render Postgres requires SSL for external/internal connections in most plans;
// rejectUnauthorized:false avoids self-signed cert failures without needing a CA bundle.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
});

module.exports = { pool };
