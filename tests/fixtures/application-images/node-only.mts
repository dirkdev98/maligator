import type { AddressInfo } from "node:net";
import type { ApplicationData, FixtureBridge } from "./types.ts";
const bridge = mal as unknown as FixtureBridge;
import "../../../src/node-globals.mjs";
import { createServer, get } from "node:http";
import { ready } from "maligator:application";

const data = bridge._applicationData() as ApplicationData;
let resolveRequest: (() => void) | undefined;
const requestReceived = new Promise<void>((resolve) => {
	resolveRequest = resolve;
});

if (typeof ReadableStream !== "function" || typeof WritableStream !== "function")
	throw new Error("Node requires stream globals without the Web surface");
const server = createServer((request, response) => {
	if (request.url === "/park") {
		resolveRequest?.();
		return;
	}
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify({ answer: 42 }));
});
await new Promise<void>((resolve) => {
	server.listen(0, "127.0.0.1", resolve);
});
const port = (server.address() as AddressInfo).port;
if (data.mode === "http-park") {
	const request = get({ host: "127.0.0.1", port, path: "/park" });
	request.on("error", () => {});
	await requestReceived;
	if (!ready()) throw new Error("live HTTP application readiness");
} else {
	const response = await fetch(`http://127.0.0.1:${port}/answer`);
	const result: unknown = await response.json();
	if (data.mode === "http-live-result") {
		bridge._applicationResult({ result, port });
	} else {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		bridge._applicationResult(result);
	}
}
