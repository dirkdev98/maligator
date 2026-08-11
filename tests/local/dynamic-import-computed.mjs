if (false) await import("./dynamic-import-computed-target.mjs");

const target = import.meta.dirname + "/dynamic-import-computed-target.mjs";
const first = await import(target);
const second = await import(target);
const asyncHooks = await import("node:async_hooks");
const https = await import("node:https");
const http2 = await import("node:http2");
const timers = await import("node:timers/promises");
const agent = new https.Agent();
const timerValue = await timers.setTimeout(0, "ready");
let rejected = false;
try {
	await import(import.meta.dirname + "/missing-dynamic-module.mjs");
} catch (error) {
	rejected = error instanceof TypeError;
}

const passed =
	first.value === 42 &&
	second.value === 42 &&
	typeof asyncHooks.AsyncLocalStorage === "function" &&
	agent instanceof https.Agent &&
	agent.destroy() === agent &&
	typeof https.request === "function" &&
	typeof http2.connect === "function" &&
	timerValue === "ready" &&
	globalThis.dynamicImportInitCount === 1 &&
	rejected;
console.log(`RESULT ${passed ? 1 : 0}/1`);
