import sqlite, { DatabaseSync, StatementSync } from "node:sqlite";

let passed = 0;
let total = 0;

function check(condition, name) {
	total++;
	if (condition) passed++;
	else console.log("FAIL: " + name);
}

function equal(actual, expected, name) {
	check(actual === expected, name);
}

check(sqlite.DatabaseSync === DatabaseSync, "default DatabaseSync identity");
check(sqlite.StatementSync === StatementSync, "default StatementSync identity");

const db = new DatabaseSync(":memory:");
check(db.isOpen, "database opens synchronously");
check(!db.isTransaction, "database starts outside a transaction");
db.exec(`
	CREATE TABLE users (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		payload BLOB
	) STRICT;
`);

const insert = db.prepare("INSERT INTO users (id, name, payload) VALUES (?, ?, ?)");
check(insert instanceof StatementSync, "prepare returns StatementSync");
let result = insert.run(1n, "Ada", new Uint8Array([1, 2, 3]));
equal(result.changes, 1, "run reports changes");
equal(result.lastInsertRowid, 1, "run reports lastInsertRowid");
const secondResult = insert.run(2n, "Grace", new Uint8Array([4, 5]));
check(result !== secondResult, "run returns a fresh summary");
equal(Object.getPrototypeOf(result), null, "run summary has null prototype");

const text = db.prepare("SELECT ? AS value");
equal(text.get("alpha").value, "alpha", "ASCII text bind");
equal(text.get("bravo").value, "bravo", "ASCII rebind uses fresh storage");
equal(text.get("Grüße 🚀").value, "Grüße 🚀", "UTF-16 text bind");
equal(text.get("").value, "", "empty text bind");

const byId = db.prepare("SELECT id, name, payload FROM users WHERE id = $id");
let row = byId.get({ id: 1n });
equal(row.id, 1, "named parameter integer");
equal(row.name, "Ada", "object row text");
check(
	row.payload instanceof Uint8Array && row.payload.length === 3 && row.payload[2] === 3,
	"BLOB returns Uint8Array",
);

const all = db.prepare("SELECT id, name FROM users ORDER BY id");
all.setReturnArrays(true);
const rows = all.all();
equal(rows.length, 2, "all returns every row");
equal(rows[0][0], 1, "array row integer");
equal(rows[1][1], "Grace", "array row text");

const big = db.prepare("SELECT 9007199254740992 AS value");
let rejectedUnsafe = false;
try {
	big.get();
} catch (error) {
	rejectedUnsafe = error instanceof RangeError;
}
check(rejectedUnsafe, "unsafe INTEGER rejects as Number");
big.setReadBigInts(true);
equal(big.get().value, 9007199254740992n, "setReadBigInts returns BigInt");

db.exec("BEGIN");
check(db.isTransaction, "BEGIN enters transaction");
db.exec("ROLLBACK");
check(!db.isTransaction, "ROLLBACK leaves transaction");

db.close();
check(!db.isOpen, "close changes isOpen");
let rejectedClosed = false;
try {
	db.prepare("SELECT 1");
} catch (error) {
	rejectedClosed = error instanceof Error;
}
check(rejectedClosed, "closed database rejects operations");

console.log("RESULT " + passed + "/" + total);
