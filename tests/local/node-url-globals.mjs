import { AsyncLocalStorage } from "node:async_hooks";

const checks = [];

const encoded = new TextEncoder().encode("OK");
checks.push(
	encoded instanceof Uint8Array,
	encoded.length === 2 && encoded[0] === 79 && encoded[1] === 75,
	new TextDecoder().decode(encoded) === "OK",
);

const query = new URLSearchParams();
query.append("label", "first");
query.append("label", "second");
checks.push(query.toString() === "label=first&label=second");

const url = new URL("https://example.com/search?" + query);
const original = { imported: { type: "Identifier", name: "value" } };
const cloned = structuredClone(original);
checks.push(
	url.hostname === "example.com",
	url.searchParams.getAll("label").join(",") === "first,second",
	cloned !== original,
	cloned.imported !== original.imported,
	cloned.imported.type === "Identifier" && cloned.imported.name === "value",
	typeof fetch === "undefined",
	typeof Response === "function",
	typeof EventTarget === "function",
);

const scope = new AsyncLocalStorage();
const order = [];
Promise.resolve().then(() => order.push("promise"));
await new Promise((resolve) => {
	scope.run("queued", () => {
		queueMicrotask(() => {
			checks.push(scope.getStore() === "queued");
			order.push("microtask");
			resolve();
		});
	});
});
checks.push(order.join(",") === "promise,microtask", scope.getStore() === undefined);

const iterableBody = new Response(
	(async function* () {
		yield "O";
		yield new Uint8Array([75]);
	})(),
);
checks.push((await iterableBody.text()) === "OK");

const passed = checks.filter(Boolean).length;
console.log(`RESULT ${passed}/${checks.length}`);
