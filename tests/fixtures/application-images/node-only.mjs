import "../../../src/node-globals.mjs";
import { createServer } from "node:http";

if (typeof ReadableStream !== "function" || typeof WritableStream !== "function")
	throw new Error("Node requires stream globals without the Web surface");
const server = createServer((_request, response) => {
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify({ answer: 42 }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const response = await fetch(`http://127.0.0.1:${server.address().port}/answer`);
const result = await response.json();
await new Promise((resolve) => server.close(resolve));
mal._applicationResult(result);
