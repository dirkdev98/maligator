import postgres from "postgres";

/* eslint-disable no-console, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Native compatibility fixture values come from postgres.js. */

const port = Number(process.env.PGPORT) || 5432;
const common = {
	connect_timeout: 3,
	database: process.env.PGDATABASE || "postgres",
	fetch_types: false,
	host: process.env.PGHOST || "localhost",
	max_lifetime: null,
	pass: process.env.PGPASSWORD || "postgres",
	port,
	ssl: false,
	user: process.env.PGUSER || "postgres",
};
const sql = postgres({ ...common, max: 2, prepare: true });
const checks = [];

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
		stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		stream.once("error", reject);
	});
}

try {
	const first = await sql`select ${41}::int + 1 as value`;
	const second = await sql`select ${40}::int + 2 as value`;
	const [prepared] = await sql.unsafe(
		"select count(*)::int as count from pg_prepared_statements",
		[],
		{ prepare: false },
	);
	checks.push(first[0].value === 42 && second[0].value === 42 && prepared.count > 0);
	console.log("POSTGRES FEATURE prepared");

	const [leftPid, rightPid] = await Promise.all([
		sql`select pg_backend_pid() as pid, pg_sleep(0.1)`,
		sql`select pg_backend_pid() as pid, pg_sleep(0.1)`,
	]);
	checks.push(leftPid[0].pid !== rightPid[0].pid);
	console.log("POSTGRES FEATURE pool");

	const query = sql`select pg_sleep(10)`.execute();
	setTimeout(() => query.cancel(), 25);
	let cancelled = false;
	try {
		await query;
	} catch (error) {
		cancelled = error?.code === "57014";
	}
	checks.push(cancelled);
	console.log("POSTGRES FEATURE cancel");

	const reserved = await sql.reserve();
	try {
		await reserved`create temporary table mal_copy (id int, value text)`;
		const writable = await reserved`copy mal_copy from stdin`.writable();
		const finished = streamFinished(writable);
		writable.end("1\tone\n2\ttwo\n");
		await finished;
		const readable =
			await reserved`copy (select * from mal_copy order by id) to stdout`.readable();
		checks.push((await streamRead(readable)) === "1\tone\n2\ttwo\n");
	} finally {
		reserved.release();
	}
	console.log("POSTGRES FEATURE copy");

	const channel = `maligator_${Date.now()}`;
	let notifyResolve;
	const notified = new Promise((resolve) => {
		notifyResolve = resolve;
	});
	const listener = await sql.listen(channel, (payload) => {
		notifyResolve(payload);
	});
	await sql.notify(channel, "ready");
	checks.push((await notified) === "ready");
	await listener.unlisten();
	console.log("POSTGRES FEATURE listen");

	const failover = postgres({
		...common,
		backoff: 0.01,
		host: ["127.0.0.1", common.host],
		max: 1,
		port: [1, port],
		prepare: false,
	});
	try {
		const [row] = await failover`select 42 as value`;
		checks.push(row.value === 42);
	} finally {
		await failover.end({ timeout: 1 });
	}
	console.log("POSTGRES FEATURE failover");

	let closeResolve;
	const connectionClosed = new Promise((resolve) => {
		closeResolve = resolve;
	});
	const reconnect = postgres({
		...common,
		backoff: 0.01,
		idle_timeout: 0.05,
		max: 1,
		onclose() {
			closeResolve();
		},
		prepare: false,
	});
	try {
		const [before] = await reconnect`select pg_backend_pid() as pid`;
		await connectionClosed;
		const [after] = await reconnect`select pg_backend_pid() as pid`;
		checks.push(before.pid !== after.pid);
	} finally {
		await reconnect.end({ timeout: 1 });
	}
	console.log("POSTGRES FEATURE reconnect");

	console.log(`RESULT ${checks.filter(Boolean).length}/${checks.length}`);
} finally {
	await sql.end({ timeout: 1 });
}
