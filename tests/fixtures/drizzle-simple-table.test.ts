import { integer } from "drizzle-orm/sqlite-core/columns/integer";
import { sqliteTable } from "drizzle-orm/sqlite-core/table";
import { expect, test } from "maligator:test";

const probes = sqliteTable("probes", {
	id: integer("id").primaryKey({ autoIncrement: true }),
});

test("compile a simple Drizzle table", () => {
	expect(typeof probes).toBe("object");
});
