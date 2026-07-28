import postgres from "postgres";

/* eslint-disable no-console, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Native compatibility fixture values come from postgres.js. */

const common = {
	connect_timeout: 3,
	database: process.env.PGDATABASE || "postgres",
	host: process.env.PGHOST || "localhost",
	max: 1,
	max_lifetime: null,
	pass: process.env.PGPASSWORD || "postgres",
	port: Number(process.env.PGPORT) || 5432,
	ssl: false,
	user: process.env.PGUSER || "postgres",
};
const sql = postgres(common);
const checks = [];

function check(condition, name) {
	checks.push(condition);
	if (!condition) console.log(`FAIL: ${name}`);
}

function streamFinished(stream) {
	return new Promise((resolve, reject) => {
		stream.once("finish", resolve);
		stream.once("error", reject);
	});
}

function streamRead(stream) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		stream.on("data", (chunk) => chunks.push(chunk));
		stream.once("end", () => resolve(Buffer.concat(chunks)));
		stream.once("error", reject);
	});
}

try {
	const timestamp = new Date("2024-01-02T03:04:05.000Z");
	const [typed] = await sql`
		select
			${sql.array([1, 2, 3], 1007)}::int[] as numbers,
			${sql.array(
				[
					["a", "b"],
					["c", "d"],
				],
				1009,
			)}::text[] as nested,
			${sql.json({ snake_key: { inner_value: 42 } })}::jsonb as payload,
			${Buffer.from([0, 1, 255])}::bytea as bytes,
			${timestamp}::timestamptz as happened_at
	`;
	check(
		typed.numbers.join() === "1,2,3" &&
			typed.nested[1][0] === "c" &&
			typed.nested[1][1] === "d" &&
			typed.payload.snake_key.inner_value === 42 &&
			Buffer.isBuffer(typed.bytes) &&
			typed.bytes.toString("hex") === "0001ff" &&
			typed.happened_at.toISOString() === timestamp.toISOString(),
		"built-in types and arrays",
	);
	console.log("POSTGRES TYPES builtins-arrays");

	const bigintSql = postgres({
		...common,
		fetch_types: false,
		types: { bigint: postgres.BigInt },
	});
	try {
		const [big] =
			await bigintSql`select ${bigintSql.types.bigint(9007199254740993n)}::bigint as value`;
		check(big.value === 9007199254740993n, "BigInt custom type");
	} finally {
		await bigintSql.end({ timeout: 1 });
	}
	const upperSql = postgres({
		...common,
		fetch_types: false,
		types: {
			upper: {
				from: [25],
				parse: (value) => value.toUpperCase(),
				serialize: (value) => value.toLowerCase(),
				to: 25,
			},
		},
	});
	try {
		const [upper] =
			await upperSql`select ${upperSql.types.upper("MiXeD")}::text as value`;
		check(upper.value === "MIXED", "custom text type");
	} finally {
		await upperSql.end({ timeout: 1 });
	}
	console.log("POSTGRES TYPES custom-bigint");

	const camelSql = postgres({
		...common,
		fetch_types: false,
		transform: { ...postgres.camel, undefined: null },
	});
	try {
		const [camel] = await camelSql`
			select
				${camelSql.json({ snake_key: { inner_value: 7 } })}::jsonb as nested_json,
				${camelSql({ missingValue: undefined })}
		`;
		check(
			camel.nestedJson.snakeKey.innerValue === 7 && camel.missingValue === null,
			"camel and undefined transforms",
		);
	} finally {
		await camelSql.end({ timeout: 1 });
	}
	const transformedSql = postgres({
		...common,
		fetch_types: false,
		transform: {
			column: { from: (name) => `column_${name}` },
			row: { from: (row) => ({ ...row, transformed: true }) },
			value: { from: (value) => (typeof value === "number" ? value * 2 : value) },
		},
	});
	try {
		const [transformed] = await transformedSql`select 21::int as answer`;
		check(
			transformed.column_answer === 42 && transformed.transformed,
			"custom row and value transforms",
		);
	} finally {
		await transformedSql.end({ timeout: 1 });
	}
	console.log("POSTGRES TYPES transforms");

	const sessionSql = postgres({
		...common,
		fetch_types: false,
		target_session_attrs: "primary",
	});
	try {
		const [session] = await sessionSql`select 42 as value`;
		check(session.value === 42, "target session attributes");
	} finally {
		await sessionSql.end({ timeout: 1 });
	}
	console.log("POSTGRES TYPES session-attrs");

	const [{ oid }] = await sql`select lo_create(0) as oid`;
	try {
		const large = await sql.largeObject(oid);
		await large.write(Buffer.from("direct"));
		await large.seek(0);
		const [{ data: direct }] = await large.read(6);
		await large.seek(0);
		const writable = await large.writable();
		const finished = streamFinished(writable);
		writable.end("streamed");
		await finished;
		await large.seek(0);
		const readable = await large.readable({ highWaterMark: 3 });
		const streamed = await streamRead(readable);
		const [{ size }] = await large.size();
		await large.truncate(4);
		const [{ size: truncated }] = await large.size();
		await large.close();
		check(
			direct.toString() === "direct" &&
				streamed.toString() === "streamed" &&
				Number(size) === 8 &&
				Number(truncated) === 4,
			"large object direct and stream access",
		);
	} finally {
		await sql`select lo_unlink(${oid})`;
	}
	console.log("POSTGRES TYPES large-object");

	const timeoutSql = postgres({ ...common, fetch_types: false });
	const pending = timeoutSql`select pg_sleep(10)`.execute().then(
		() => false,
		(error) => error?.code === "CONNECTION_DESTROYED",
	);
	await new Promise((resolve) => {
		setTimeout(resolve, 25);
	});
	await timeoutSql.end({ timeout: 0.01 });
	check(await pending, "end timeout destroys pending query");
	console.log("POSTGRES TYPES end-timeout");

	console.log(`RESULT ${checks.filter(Boolean).length}/${checks.length}`);
} finally {
	await sql.end({ timeout: 1 });
}
