import timers from "node:timers";
import { scheduler, setImmediate, setInterval, setTimeout } from "node:timers/promises";

const lines = [];
const show = (label, value) => lines.push(`${label} ${JSON.stringify(value)}`);
const errorShape = (error) => [error.name, error.code, error.message];

show("timers identity", [
	timers.setTimeout === globalThis.setTimeout,
	timers.clearInterval === globalThis.clearInterval,
	timers.setImmediate === globalThis.setImmediate,
	typeof timers.promises.setTimeout,
]);
show("setTimeout value", await setTimeout(1, "late"));
show("setImmediate value", await setImmediate("soon"));
show("scheduler", [await scheduler.wait(1), await scheduler.yield()]);
show("bad delay", await setTimeout("5").catch(errorShape));
show("bad options", await setTimeout(1, null, 3).catch(errorShape));
show("bad signal", await setTimeout(1, null, { signal: {} }).catch(errorShape));
show("bad ref", await setImmediate(null, { ref: 1 }).catch(errorShape));
show(
	"aborted",
	await setTimeout(1, null, { signal: AbortSignal.abort("why") }).catch((error) => [
		...errorShape(error),
		error.cause,
	]),
);
const controller = new AbortController();
const pending = setTimeout(1000, null, { signal: controller.signal });
controller.abort(new Error("stop"));
show(
	"abort while waiting",
	await pending.catch((error) => [error.name, error.cause.message]),
);
const unrefed = setTimeout(5, "unref", { ref: false });
show(
	"unref still settles while the loop is busy",
	await Promise.race([unrefed, setTimeout(50, "ref")]),
);

const ticks = [];
let count = 0;
for await (const value of setInterval(1, "tick")) {
	ticks.push(value);
	if (++count === 3) break;
}
show("setInterval", ticks);
const intervalAbort = new AbortController();
const iterator = setInterval(1, "x", { signal: intervalAbort.signal });
show("first tick", await iterator.next());
intervalAbort.abort();
show("aborted interval", await iterator.next().catch((error) => error.name));
const badInterval = setInterval(1, "x", { ref: "no" });
show("bad interval options", await badInterval.next().catch(errorShape));
show("returned interval", await setInterval(1).return("done"));
console.log(lines.join("\n"));
