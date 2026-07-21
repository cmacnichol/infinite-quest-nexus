import { Pool } from "pg";
const pool = new Pool({ connectionString: "postgres://postgres:postgres@localhost:5432/postgres" });
async function run() {
  await pool.query(`CREATE TABLE IF NOT EXISTS test_uuid_any (id uuid)`);
  await pool.query(`INSERT INTO test_uuid_any (id) VALUES ('00000000-0000-0000-0000-000000000000')`);
  try {
    const res = await pool.query(`SELECT * FROM test_uuid_any WHERE id = ANY($1)`, [['00000000-0000-0000-0000-000000000000']]);
    console.log("ANY($1) rows:", res.rows.length);
  } catch (e) {
    console.error("Error with ANY($1)", e);
  }

  try {
    const res2 = await pool.query(`SELECT * FROM test_uuid_any WHERE id = ANY($1::uuid[])`, [['00000000-0000-0000-0000-000000000000']]);
    console.log("ANY($1::uuid[]) rows:", res2.rows.length);
  } catch (e) {
    console.error("Error with ANY($1::uuid[])", e);
  }
  await pool.end();
}
run();
