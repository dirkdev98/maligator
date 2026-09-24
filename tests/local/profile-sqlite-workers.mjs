import { DatabaseSync } from "node:sqlite";

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA threads=2");
const rows = database
	.prepare(`
	WITH RECURSIVE numbers(value) AS (
		SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 2000
	)
	SELECT value FROM numbers ORDER BY value DESC
`)
	.all();
if (rows.length !== 2000 || rows[0].value !== 2000) throw new Error("bad sort");
database.close();
console.log("done");
