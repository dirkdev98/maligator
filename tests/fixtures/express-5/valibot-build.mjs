/* eslint-disable -- This integration fixture intentionally mirrors untyped user code. */

import express from "express";
import { literal, object, parse } from "valibot";

const Ping = object({
	status: literal("ok"),
});

const app = express();

app.get("/ping", (_request, response) => {
	response.json(parse(Ping, { status: "ok" }));
});

app.listen(3000);
