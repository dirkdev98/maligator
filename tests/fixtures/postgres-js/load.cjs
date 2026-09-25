"use strict";

/* oxlint-disable -- This compatibility fixture intentionally uses untyped CommonJS. */

const postgres = require("postgres");

const sql = postgres({
	connect_timeout: null,
	fetch_types: false,
	idle_timeout: null,
	max: 1,
	max_lifetime: null,
	no_subscribe: true,
});

const checks = [
	typeof postgres === "function",
	typeof postgres.PostgresError === "function",
	postgres.toCamel("hello_world") === "helloWorld",
	typeof sql === "function",
	typeof sql.unsafe === "function",
	typeof sql.json === "function",
	sql.options.max === 1,
	sql.options.fetch_types === false,
];

console.log(`RESULT ${checks.filter(Boolean).length}/${checks.length}`);
