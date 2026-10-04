import type { AddressInfo } from "node:net";
import type { FixtureBridge } from "./types.ts";
const bridge = mal as unknown as FixtureBridge;
import "../../../src/node-globals.mjs";
import { createServer } from "node:http";

if (typeof ReadableStream !== "function" || typeof WritableStream !== "function")
	throw new Error("Node requires stream globals without the Web surface");
const server = createServer((_request, response) => {
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify({ answer: 42 }));
});
await new Promise<void>((resolve) => {
	server.listen(0, "127.0.0.1", resolve);
});
const response = await fetch(
	`http://127.0.0.1:${(server.address() as AddressInfo).port}/answer`,
);
const result: unknown = await response.json();
await new Promise<void>((resolve) => {
	server.close(() => resolve());
});
bridge._applicationResult(result);
