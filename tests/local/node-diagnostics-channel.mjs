import { AsyncLocalStorage } from "node:async_hooks";
import dc, {
	Channel,
	channel,
	hasSubscribers,
	subscribe,
	tracingChannel,
	unsubscribe,
} from "node:diagnostics_channel";

const lines = [];
const show = (label, value) => lines.push(`${label} ${JSON.stringify(value)}`);
const ch = channel("x");
show("inactive", [
	ch.constructor.name,
	ch.hasSubscribers,
	ch.name,
	ch instanceof Channel,
	channel("x") === ch,
]);
const received = [];
const onMessage = (message, name) => received.push([message, name]);
ch.subscribe(onMessage);
show("active", [
	ch.constructor.name,
	ch.hasSubscribers,
	hasSubscribers("x"),
	ch instanceof Channel,
]);
ch.publish({ a: 1 });
show("received", received);
show("unsubscribe", [
	ch.unsubscribe(onMessage),
	ch.unsubscribe(onMessage),
	ch.hasSubscribers,
	ch.constructor.name,
]);
const symbolName = Symbol("s");
subscribe(symbolName, onMessage);
channel(symbolName).publish(2);
show("symbol channel", [
	received.length,
	unsubscribe(symbolName, onMessage),
	unsubscribe("never", onMessage),
]);
process.on("uncaughtException", (error) => show("uncaught", error.message));
subscribe("y", () => {
	throw new Error("subscriber failed");
});
subscribe("y", (message) => show("second subscriber", message));
channel("y").publish(1);
show("after publish", true);
try {
	channel(1);
} catch (error) {
	show("bad name", [error.code, error.message]);
}
const store = new AsyncLocalStorage();
const stored = channel("stored");
stored.bindStore(store, (data) => ({ wrapped: data }));
stored.subscribe((message) => show("store subscriber sees", [message, store.getStore()]));
show(
	"runStores",
	stored.runStores("payload", (a, b) => [a, b, store.getStore()], null, 1, 2),
);
show("unbindStore", [stored.unbindStore(store), stored.unbindStore(store)]);
const tc = tracingChannel("op");
show("tracing", [Object.keys(tc), tc.start.name, tc.error.name, tc.hasSubscribers]);
const events = [];
tc.subscribe({
	start: (context) => events.push(["start", context.value]),
	end: (context) => events.push(["end", context.result ?? null]),
	asyncStart: () => events.push(["asyncStart"]),
	asyncEnd: () => events.push(["asyncEnd"]),
	error: (context) => events.push(["error", context.error.message]),
});
show(
	"traceSync",
	tc.traceSync((a) => a * 2, { value: 1 }, null, 21),
);
try {
	tc.traceSync(
		() => {
			throw new Error("boom");
		},
		{ value: 2 },
	);
} catch (error) {
	events.push(["caught", error.message]);
}
show("tracePromise", await tc.tracePromise(async () => 7, { value: 3 }));
show(
	"tracePromise rejection",
	await tc
		.tracePromise(
			async () => {
				throw new Error("async boom");
			},
			{ value: 4 },
		)
		.catch((error) => error.message),
);
show("events", events);
show("default", [dc.channel === channel, typeof dc.tracingChannel]);
setTimeout(() => console.log(lines.join("\n")), 5);
