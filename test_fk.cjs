const { Client } = require('pg');

async function run() {
  const client = new Client({
    connectionString: "postgresql://infinitequest:password@localhost:5432/infinitequest_test",
  });
  await client.connect();

  try {
    await client.query(`DROP TABLE IF EXISTS t2, t1, u CASCADE;`);
    const res = await client.query(`
      CREATE TABLE IF NOT EXISTS u (id int PRIMARY KEY);
      INSERT INTO u VALUES (1) ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS t1 (id int PRIMARY KEY, u_id int NOT NULL REFERENCES u(id), UNIQUE(id, u_id));
      INSERT INTO t1 VALUES (10, 1) ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS t2 (id int PRIMARY KEY, t_id int, u_id int NOT NULL REFERENCES u(id), FOREIGN KEY (t_id, u_id) REFERENCES t1(id, u_id) ON DELETE SET NULL (t_id));
      INSERT INTO t2 VALUES (100, 10, 1) ON CONFLICT DO NOTHING;
      DELETE FROM t1 WHERE id = 10;
    `);
    const res2 = await client.query(`SELECT * FROM t2;`);
    console.log("Success", res2.rows);
  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
}
run();
