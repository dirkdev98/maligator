import postgres from "postgres";

/* eslint-disable no-console -- Native compatibility fixtures report through stdout. */

const sql = postgres({
	connect_timeout: 5,
	database: "postgres",
	fetch_types: false,
	host: "127.0.0.1",
	max: 1,
	max_lifetime: null,
	pass: "postgres",
	port: Number(process.env.PGPORT),
	prepare: false,
	ssl: false,
	user: "postgres",
});

try {
	const [row] = await sql.unsafe("select 1 as value").simple();
	console.log(`RESULT ${row.value === 1 ? 1 : 0}/1`);
} finally {
	await sql.end({ timeout: 1 });
}
