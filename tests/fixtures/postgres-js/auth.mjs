import postgres from "postgres";

/* oxlint-disable no-console -- Native compatibility fixtures report through stdout. */

let passwordCalls = 0;
const password =
	process.env.PGPASSWORD_DYNAMIC === "sync"
		? () => {
				passwordCalls++;
				return "postgres";
			}
		: process.env.PGPASSWORD_DYNAMIC === "async"
			? async () => {
					passwordCalls++;
					await Promise.resolve();
					return "postgres";
				}
			: "postgres";
const sql = postgres({
	connect_timeout: 5,
	database: "postgres",
	fetch_types: false,
	host: process.env.PGHOST || "127.0.0.1",
	max: 1,
	max_lifetime: null,
	pass: password,
	port: Number(process.env.PGPORT),
	prepare: false,
	ssl: process.env.PGSSL_CA
		? { ca: process.env.PGSSL_CA, servername: "localhost" }
		: process.env.PGSSL_INSECURE === "1"
			? "require"
			: false,
	sslnegotiation: process.env.PGSSL_DIRECT === "1" ? "direct" : "postgres",
	user: "postgres",
});

try {
	const [row] = await sql.unsafe("select 1 as value").simple();
	const expectedCalls = process.env.PGPASSWORD_DYNAMIC ? 1 : 0;
	console.log(`RESULT ${row.value === 1 && passwordCalls === expectedCalls ? 1 : 0}/1`);
} finally {
	await sql.end({ timeout: 1 });
}
