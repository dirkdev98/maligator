import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { EventEmitter, EventEmitterAsyncResource, once } from "node:events";

function check(value, message) {
	if (!value) throw new Error(message);
}

const storage = new AsyncLocalStorage();
class PoolEvents extends EventEmitterAsyncResource {
	constructor() {
		super({ name: "pool-events", triggerAsyncId: 500 });
	}
}
const events = storage.run("created", () => new PoolEvents());
check(
	events instanceof PoolEvents && events instanceof EventEmitter,
	"subclass prototype",
);
check(
	events.asyncResource.asyncId() === events.asyncId && events.triggerAsyncId === 500,
	"resource identity",
);
let seen;
events.on("work", () => {
	seen = storage.getStore();
});
storage.run("emitting", () => events.emit("work"));
check(seen === "created", "emit restores creation context");
check(storage.getStore() === undefined, "emit restores caller context");

const task = storage.run(
	"task",
	() => new AsyncResource("task", { triggerAsyncId: events.asyncId }),
);
check(task.triggerAsyncId() === events.asyncId, "explicit triggering resource");
task.runInAsyncScope(() => {
	check(storage.getStore() === "task", "task context");
	check(
		new AsyncResource("child").triggerAsyncId() === task.asyncId(),
		"nested triggering resource",
	);
});

const result = once(events, "done");
events.emit("done", 7, "result");
check(JSON.stringify(await result) === '[7,"result"]', "once argument array");
check(
	events.listenerCount("done") === 0 && events.listenerCount("error") === 0,
	"once cleanup",
);
const failure = once(events, "missing");
const error = new Error("failed");
events.emit("error", error);
let reason;
try {
	await failure;
} catch (caught) {
	reason = caught;
}
check(
	reason === error && events.listenerCount("missing") === 0,
	"once error and cleanup",
);
events.emitDestroy();
task.emitDestroy();
console.log("worker-events PASS");
