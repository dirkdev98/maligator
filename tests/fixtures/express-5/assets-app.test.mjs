/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- JavaScript fixture imports an intentionally untyped CommonJS app. */

import { afterAll, beforeAll, expect, test } from "maligator:test";
import expressFixture from "./assets-app.cjs";

let origin;
let close;

beforeAll(async () => {
	({ origin, close } = await expressFixture.listen());
});

afterAll(async () => {
	await close();
});

test("serves files materialized from the configured Mal asset", async () => {
	const response = await fetch(`${origin}/assets/hello.txt`);
	expect(response.status).toBe(200);
	await expect(response.text()).resolves.toBe("static payload\n");

	const hidden = await fetch(`${origin}/assets/.secret`);
	expect(hidden.status).toBe(404);
	await expect(hidden.json()).resolves.toEqual({
		error: "Not found: GET /assets/.secret",
	});
});

test("runs Express middleware and JSON routing in the test runtime", async () => {
	const response = await fetch(`${origin}/api/echo`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ command: "test", works: true }),
	});
	expect(response.status).toBe(201);
	await expect(response.json()).resolves.toEqual({
		body: { command: "test", works: true },
	});
});
