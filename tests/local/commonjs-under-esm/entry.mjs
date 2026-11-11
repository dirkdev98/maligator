import { createRequire } from "node:module";
import bridge from "./bridge.cjs";

const require = createRequire(import.meta.url);
console.log("before", globalThis.mixedRequireEvents.join(","));
const first = bridge.load();
const second = bridge.load();
console.log("lazy", globalThis.mixedRequireEvents.join(","));
console.log("identity", first === second, first === require("./target.mjs"));
first.increment();
const imported = await import("./target.mjs");
console.log("live", first.value, imported.value, first.increment === imported.increment);
console.log("default", first.default.label);
globalThis.mixedRequireFailure = { label: "failure" };
for (let i = 0; i < 2; i++) {
	try {
		bridge.fail();
	} catch (error) {
		console.log("failure", error === globalThis.mixedRequireFailure);
	}
}
try {
	await import("./failure.mjs");
} catch (error) {
	console.log("import failure", error === globalThis.mixedRequireFailure);
}
console.log("final", globalThis.mixedRequireEvents.join(","));
