import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const users = sqliteTable("users", {
	id: integer().primaryKey(),
	name: text().notNull(),
	active: integer({ mode: "boolean" }).notNull(),
});

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

const db = drizzle(":memory:");
db.$client.exec(`
	CREATE TABLE users (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		active INTEGER NOT NULL
	) STRICT;
`);

let insertResult = db.insert(users).values({ id: 1, name: "Ada", active: true }).run();
equal(insertResult.changes, 1, "insert reports one changed row");
db.insert(users)
	.values([
		{ id: 2, name: "Grace", active: true },
		{ id: 3, name: "Linus", active: false },
	])
	.run();

const selected = db
	.select({ id: users.id, name: users.name, active: users.active })
	.from(users)
	.where(eq(users.active, true))
	.orderBy(users.id)
	.all();
equal(selected.length, 2, "typed select filters rows");
equal(selected[0].name, "Ada", "typed select maps text");
equal(selected[1].active, true, "boolean column maps integer");

const prepared = db
	.select({ name: users.name })
	.from(users)
	.where(eq(users.id, sql.placeholder("id")))
	.prepare();
equal(prepared.get({ id: 2 }).name, "Grace", "prepared placeholder binds");

db.transaction((tx) => {
	tx.update(users).set({ name: "Grace Hopper" }).where(eq(users.id, 2)).run();
	tx.transaction((nested) => {
		nested.delete(users).where(eq(users.id, 3)).run();
	});
});
equal(
	db.select({ name: users.name }).from(users).where(eq(users.id, 2)).get().name,
	"Grace Hopper",
	"transaction commits",
);
equal(
	db
		.select({ count: sql`count(*)` })
		.from(users)
		.get().count,
	2,
	"nested transaction uses savepoint",
);

db.$client.close();
console.log("RESULT " + passed + "/" + total);
