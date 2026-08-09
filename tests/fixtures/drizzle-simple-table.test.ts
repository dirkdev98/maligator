import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { expect, test } from "maligator:test";

const probes = sqliteTable("probes", {
	id: integer("id").primaryKey({ autoIncrement: true }),
});

test("compile a simple Drizzle table", () => {
	expect(typeof probes).toBe("object");
});
