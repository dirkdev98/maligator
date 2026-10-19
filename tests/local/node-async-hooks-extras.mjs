import {
	AsyncResource,
	asyncWrapProviders,
	createHook,
	executionAsyncId,
	executionAsyncResource,
	triggerAsyncId,
} from "node:async_hooks";

const lines = [];
const show = (label, value) => lines.push(`${label} ${JSON.stringify(value)}`);
show("top level", [
	executionAsyncId(),
	triggerAsyncId(),
	typeof executionAsyncResource(),
]);
show("providers", [
	Object.isFrozen(asyncWrapProviders),
	asyncWrapProviders.ZLIB,
	Object.keys(asyncWrapProviders).length,
]);
try {
	createHook({ init: 1 });
} catch (error) {
	show("bad hook", [error.code, error.message]);
}
const events = [];
const ids = new Set();
const hook = createHook({
	init(id, type, trigger, resource) {
		if (type !== "Mine") return;
		ids.add(id);
		events.push([
			"init",
			type,
			trigger === executionAsyncId(),
			resource instanceof AsyncResource,
			this === hook,
		]);
	},
	before(id) {
		if (ids.has(id)) events.push(["before"]);
	},
	after(id) {
		if (ids.has(id)) events.push(["after"]);
	},
	destroy(id) {
		if (ids.has(id)) events.push(["destroy"]);
	},
});
show("enable returns hook", hook.enable() === hook);
const resource = new AsyncResource("Mine");
resource.runInAsyncScope(() => {
	events.push([
		"inside",
		executionAsyncId() === resource.asyncId(),
		triggerAsyncId() === resource.triggerAsyncId(),
	]);
});
resource.emitDestroy();
await new Promise((resolve) => setTimeout(resolve, 5));
hook.disable();
new AsyncResource("Mine").runInAsyncScope(() => {});
show("events", events);
console.log(lines.join("\n"));
