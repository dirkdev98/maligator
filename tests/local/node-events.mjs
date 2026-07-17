import Events, { EventEmitter } from "node:events";

let passed = 0;
let total = 0;

function check(condition, name) {
	total++;
	if (condition) {
		passed++;
	} else {
		console.log("FAIL: " + name);
	}
}

check(Events === EventEmitter, "default/named identity");
check(Events.EventEmitter === EventEmitter, "constructor named property identity");
check(EventEmitter.prototype.on === EventEmitter.prototype.addListener, "on alias");
check(EventEmitter.prototype.off === EventEmitter.prototype.removeListener, "off alias");

const emitter = new EventEmitter();
check(emitter instanceof EventEmitter, "constructed instance");
check(emitter.getMaxListeners() === 10, "default max listeners");
check(emitter.setMaxListeners(4) === emitter, "setMaxListeners chaining");
check(emitter.getMaxListeners() === 4, "custom max listeners");
let invalidMax = false;
try {
	emitter.setMaxListeners(-1);
} catch (error) {
	invalidMax = error instanceof RangeError;
}
check(invalidMax, "invalid max listeners");

const additions = [];
emitter.on("newListener", (name, listener) => {
	if (name === "work") additions.push([listener, emitter.listenerCount(name)]);
});
const order = [];
function tail(value) {
	check(this === emitter && value === 7, "listener this/argument");
	order.push("tail");
}
function first() {
	order.push("first");
}
function one() {
	order.push("once");
}
emitter.on("work", tail);
emitter.prependListener("work", first);
emitter.prependOnceListener("work", one);
check(
	additions.length === 3 && additions[0][0] === tail,
	"newListener listener identity",
);
check(
	additions[0][1] === 0 && additions[1][1] === 1 && additions[2][1] === 2,
	"newListener before insertion",
);
check(emitter.emit("work", 7) === true, "emit returns true");
check(order.join(",") === "once,first,tail", "prepend and once order");
order.length = 0;
emitter.emit("work", 7);
check(order.join(",") === "first,tail", "once removed before second emit");
check(
	emitter.listeners("work")[0] === first && emitter.listeners("work")[1] === tail,
	"listeners snapshot",
);
check(emitter.rawListeners("work")[0] === first, "rawListeners ordinary listener");
check(emitter.listenerCount("work") === 2, "listenerCount");
check(emitter.listenerCount("work", tail) === 1, "listenerCount listener filter");
check(EventEmitter.listenerCount(emitter, "work") === 2, "static listenerCount");

const onceEmitter = new EventEmitter();
let onceCalls = 0;
function original() {
	onceCalls++;
}
onceEmitter.once("tick", original);
const raw = onceEmitter.rawListeners("tick")[0];
check(raw !== original && raw.listener === original, "raw once wrapper");
check(onceEmitter.listeners("tick")[0] === original, "listeners unwrap once");
raw();
raw();
check(
	onceCalls === 1 && onceEmitter.listenerCount("tick") === 0,
	"once wrapper manual call guard",
);
onceEmitter.once("removed", original);
onceEmitter.removeListener("removed", original);
onceEmitter.emit("removed");
check(onceCalls === 1, "remove once by original listener");

const removals = [];
const removing = new EventEmitter();
removing.on("removeListener", (name, listener) => {
	if (name === "gone") removals.push([listener, removing.listenerCount(name)]);
});
function gone() {}
removing.on("gone", gone);
check(removing.off("gone", gone) === removing, "off chaining");
check(
	removals.length === 1 && removals[0][0] === gone && removals[0][1] === 0,
	"removeListener after removal",
);

const snapshot = new EventEmitter();
const snapshotOrder = [];
function second() {
	snapshotOrder.push("second");
}
snapshot.on("change", () => {
	snapshotOrder.push("first");
	snapshot.removeListener("change", second);
});
snapshot.on("change", second);
snapshot.emit("change");
snapshot.emit("change");
check(snapshotOrder.join(",") === "first,second,first", "emit mutation snapshot");

const names = new EventEmitter();
const symbolEvent = Symbol("symbol-event");
names.on("alpha", () => {});
names.on(symbolEvent, () => {});
const eventNames = names.eventNames();
check(
	eventNames.length === 2 && eventNames[0] === "alpha" && eventNames[1] === symbolEvent,
	"eventNames strings and symbols",
);
names.removeAllListeners("alpha");
check(
	names.listenerCount("alpha") === 0 && names.listenerCount(symbolEvent) === 1,
	"removeAllListeners event",
);
names.removeAllListeners();
check(names.eventNames().length === 0, "removeAllListeners all");

check(new EventEmitter().emit("absent") === false, "emit returns false");
const errorEmitter = new EventEmitter();
const sentinel = { sentinel: true };
let thrown;
try {
	errorEmitter.emit("error", sentinel);
} catch (error) {
	thrown = error;
}
check(thrown === sentinel, "unhandled error throws argument");
let generatedError = false;
try {
	errorEmitter.emit("error");
} catch (error) {
	generatedError = error instanceof Error;
}
check(generatedError, "unhandled error creates Error");
let handledError;
errorEmitter.once("error", (error) => {
	handledError = error;
});
check(
	errorEmitter.emit("error", sentinel) && handledError === sentinel,
	"handled error event",
);

let listenerThrow;
errorEmitter.on("throws", () => {
	throw sentinel;
});
try {
	errorEmitter.emit("throws");
} catch (error) {
	listenerThrow = error;
}
check(listenerThrow === sentinel, "listener exception propagates");

function LegacyEmitter() {
	EventEmitter.call(this);
}
LegacyEmitter.prototype = Object.create(EventEmitter.prototype);
LegacyEmitter.prototype.constructor = LegacyEmitter;
const legacy = new LegacyEmitter();
let legacyCalled = false;
legacy.on("legacy", () => {
	legacyCalled = true;
});
legacy.emit("legacy");
check(legacyCalled && legacy instanceof EventEmitter, "EventEmitter.call inheritance");

class DerivedEmitter extends EventEmitter {}
const derived = new DerivedEmitter();
check(
	derived instanceof DerivedEmitter && derived instanceof EventEmitter,
	"class inheritance",
);

let bareCallError = false;
try {
	EventEmitter();
} catch (error) {
	bareCallError = error instanceof TypeError;
}
check(bareCallError, "bare call incompatible receiver");

let invalidListener = false;
try {
	emitter.on("bad", 1);
} catch (error) {
	invalidListener = error instanceof TypeError;
}
check(invalidListener, "listener validation");

console.log("RESULT " + passed + "/" + total);
