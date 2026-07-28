import postgres from "postgres";

/* eslint-disable no-console, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Native compatibility fixture values come from postgres.js. */

const sql = postgres({
	connect_timeout: 3,
	database: process.env.PGDATABASE || "postgres",
	fetch_types: false,
	host: process.env.PGHOST || "localhost",
	max: 2,
	max_lifetime: null,
	pass: process.env.PGPASSWORD || "postgres",
	port: Number(process.env.PGPORT) || 5432,
	ssl: false,
	user: process.env.PGUSER || "postgres",
});
const table = `mal_query_api_${Date.now()}`;
const checks = [];
const rollbackMarker = new Error("rollback marker");

try {
	await sql`create table ${sql(table)} (id int primary key, value text not null)`;

	const savepointCode = await sql.begin("read write", async (tx) => {
		await tx`insert into ${tx(table)} ${tx({ id: 1, value: "one" })}`;
		let code;
		try {
			await tx.savepoint(
				"duplicate",
				(nested) => nested`insert into ${nested(table)} values (1, 'duplicate')`,
			);
		} catch (error) {
			code = error?.code;
		}
		await tx`insert into ${tx(table)} ${tx({ id: 2, value: "two" })}`;
		return code;
	});
	const committed = await sql`select id from ${sql(table)} order by id`;
	checks.push(
		savepointCode === "23505" && committed.map((row) => row.id).join() === "1,2",
	);
	console.log("POSTGRES QUERY transaction-savepoint");

	let rollbackIdentity = false;
	try {
		await sql.begin(async (tx) => {
			await tx`insert into ${tx(table)} values (3, 'three')`;
			throw rollbackMarker;
		});
	} catch (error) {
		rollbackIdentity = error === rollbackMarker;
	}
	const [rolledBack] =
		await sql`select count(*)::int as count from ${sql(table)} where id = 3`;
	checks.push(rollbackIdentity && rolledBack.count === 0);
	console.log("POSTGRES QUERY rollback");

	await sql.begin((tx) => [
		tx`insert into ${tx(table)} values (4, 'four')`,
		tx`insert into ${tx(table)} values (5, 'five')`,
	]);
	const dynamic = await sql`
		select ${sql(["id", "value"])} from ${sql(table)}
		where id in ${sql([1, 2, 4, 5])}
		${sql`order by id desc`}
	`;
	checks.push(
		dynamic.map((row) => `${row.id}:${row.value}`).join() === "5:five,4:four,2:two,1:one",
	);
	console.log("POSTGRES QUERY builders-pipeline");

	const callbackCursor = [];
	await sql`select x from generate_series(1, 5) as x`.cursor(2, async (rows) => {
		callbackCursor.push(rows.map((row) => row.x).join(""));
		await Promise.resolve();
	});
	const iterableCursor = [];
	for await (const rows of sql`select x from generate_series(6, 10) as x`.cursor(2)) {
		iterableCursor.push(rows.map((row) => row.x).join(""));
		if (iterableCursor.length === 2) break;
	}
	checks.push(callbackCursor.join() === "12,34,5" && iterableCursor.join() === "67,89");
	console.log("POSTGRES QUERY cursors");

	const iterated = [];
	await sql`select x from generate_series(1, 3) as x`.forEach((row) => {
		iterated.push(row.x);
	});
	checks.push(iterated.join() === "1,2,3");
	console.log("POSTGRES QUERY foreach");

	const description =
		await sql`select ${42}::int as answer, ${"text"}::text as label`.describe();
	checks.push(
		description.string.includes("$1::int") &&
			description.types.length === 2 &&
			description.columns.map((column) => column.name).join() === "answer,label",
	);
	const values = await sql`select 42::int as answer, 'text'::text as label`.values();
	const raw = await sql`select 42::int as answer, 'text'::text as label`.raw();
	checks.push(
		values[0][0] === 42 &&
			values[0][1] === "text" &&
			Buffer.isBuffer(raw[0][0]) &&
			raw[0][0].toString() === "42" &&
			raw[0][1].toString() === "text",
	);
	console.log("POSTGRES QUERY describe-values-raw");

	const simple = await sql`select 1::int as value; select 2::int as value`.simple();
	console.log("POSTGRES QUERY simple");
	const unsafe = await sql`select ${sql.unsafe("40")}::int + ${2}::int as value`;
	console.log("POSTGRES QUERY unsafe");
	const file = await sql.file("tests/fixtures/postgres-js/query-api.sql", [20, 22]);
	console.log("POSTGRES QUERY file");
	checks.push(
		Array.isArray(simple) &&
			simple.length === 2 &&
			simple[0][0].value === 1 &&
			simple[1][0].value === 2 &&
			unsafe[0].value === 42 &&
			file[0].value === 42 &&
			file.command === "SELECT" &&
			file.count === 1 &&
			file.columns[0].name === "value" &&
			file.statement.string.includes("$1::int"),
	);
	console.log("POSTGRES QUERY simple-unsafe-file-metadata");

	console.log(`RESULT ${checks.filter(Boolean).length}/${checks.length}`);
} finally {
	try {
		await sql`drop table if exists ${sql(table)}`;
	} finally {
		await sql.end({ timeout: 1 });
	}
}
