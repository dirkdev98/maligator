// Callbacks that start without a context and install one with enterWith(): the
// context belongs to that callback's continuations only, never to the next
// microtask, timer or host callback.
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";

const storage = new AsyncLocalStorage();
const log = [];
const note = (label) => log.push(`${label}: ${storage.getStore() ?? "none"}`);

const jobsDone = new Promise((resolve) => {
	Promise.resolve().then(() => {
		storage.enterWith("first-job");
		note("enterWith job");
		Promise.resolve().then(() => note("continuation of enterWith job"));
	});
	Promise.resolve().then(() => note("next job"));
	queueMicrotask(() => note("queued microtask"));
	setTimeout(resolve, 0);
});
await jobsDone;
note("after microtasks");

const timersDone = new Promise((resolve) => {
	setTimeout(() => {
		storage.enterWith("timer");
		note("enterWith timer");
		Promise.resolve().then(() => note("job from enterWith timer"));
		setTimeout(() => note("timer from enterWith timer"), 0);
	}, 0);
	setTimeout(() => note("next timer"), 0);
	setTimeout(resolve, 5);
});
await timersDone;
note("after timers");

const emitter = new EventEmitter();
emitter.on("event", () => {
	storage.enterWith("listener");
	note("enterWith listener");
});
await new Promise((resolve) => {
	setImmediate(() => {
		emitter.emit("event");
		note("after emit in same callback");
		resolve();
	});
});
note("after immediate");

await storage.run("run", async () => {
	await null;
	note("run continuation");
	setTimeout(() => note("timer inside run"), 0);
	await new Promise((resolve) => setTimeout(resolve, 2));
	note("run after timer");
});
note("after run");

console.log(log.join("\n"));
