import postgres from "postgres";

/* oxlint-disable no-console -- Native compatibility fixtures report through stdout. */

const sql = postgres({
	connect_timeout: 5,
	database: process.env.PGDATABASE || "postgres",
	fetch_types: false,
	host: process.env.PGHOST || "127.0.0.1",
	max: 1,
	max_lifetime: null,
	pass: process.env.PGPASSWORD || "postgres",
	port: Number(process.env.PGPORT) || 5432,
	prepare: false,
	ssl: false,
	user: process.env.PGUSER || "postgres",
});

try {
	const [row] =
		await sql`select current_database() as database, current_user as username, 1 as value`;
	const checks = [
		row.database === "postgres",
		row.username === "postgres",
		row.value === 1,
	];
	console.log(`RESULT ${checks.filter(Boolean).length}/${checks.length}`);
} finally {
	await sql.end({ timeout: 1 });
}
