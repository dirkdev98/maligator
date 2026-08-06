/* eslint-disable -- This integration fixture mirrors the reported dependency graph. */

import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import express from "express";
import { literal, object, parse } from "valibot";

const client = new DatabaseSync(":memory:");
const database = drizzle({ client });
database.run(sql`create table message (value text not null)`);

const ResponseSchema = object({ status: literal("ok") });
const app = express();
app.get("/", (_request, response) => {
	response.json(parse(ResponseSchema, { status: "ok" }));
});
app.listen(3000);
