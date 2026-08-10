// DOMException / Event / EventTarget / AbortController / AbortSignal fixture.
// Sync checks run first; AbortSignal.timeout (async, via the event loop) finalizes
// the run and prints RESULT from its abort listener.

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}

// --- DOMException ---
check("DOMException global", typeof DOMException === "function");
check("DOMException constructor length", DOMException.length === 0);
let domCallThrew = false;
try {
	DOMException();
} catch (err) {
	domCallThrew = err instanceof TypeError;
}
check("DOMException requires new", domCallThrew);

const domDefault = new DOMException();
check(
	"DOMException defaults",
	domDefault.name === "Error" && domDefault.message === "" && domDefault.code === 0,
);
const domAbort = new DOMException("stopped", "AbortError");
check(
	"DOMException fields and inheritance",
	domAbort.name === "AbortError" &&
		domAbort.message === "stopped" &&
		domAbort.code === 20 &&
		domAbort instanceof DOMException &&
		domAbort instanceof Error &&
		String(domAbort) === "AbortError: stopped",
);
check(
	"DOMException legacy codes",
	new DOMException("", "IndexSizeError").code === 1 &&
		new DOMException("", "TimeoutError").code === 23 &&
		new DOMException("", "DataCloneError").code === 25 &&
		new DOMException("", "DOMStringSizeError").code === 0 &&
		new DOMException("", "UnknownError").code === 0,
);
check(
	"DOMException legacy constants",
	DOMException.ABORT_ERR === 20 &&
		DOMException.prototype.ABORT_ERR === 20 &&
		DOMException.TIMEOUT_ERR === 23 &&
		DOMException.DATA_CLONE_ERR === 25,
);
const converted = new DOMException(123, { toString: () => "NetworkError" });
check(
	"DOMException converts message and name",
	converted.message === "123" &&
		converted.name === "NetworkError" &&
		converted.code === 19,
);
let readonlyThrew = false;
try {
	domAbort.name = "TimeoutError";
} catch (err) {
	readonlyThrew = err instanceof TypeError;
}
check(
	"DOMException fields are readonly",
	readonlyThrew && domAbort.name === "AbortError" && domAbort.message === "stopped",
);
let domBrandThrew = false;
try {
	Object.getOwnPropertyDescriptor(DOMException.prototype, "name").get.call({});
} catch (err) {
	domBrandThrew = err instanceof TypeError;
}
check("DOMException getters brand-check", domBrandThrew);
check(
	"DOMException state is reflection-hidden",
	!Object.getOwnPropertyNames(domAbort).includes("name") &&
		!Object.getOwnPropertyNames(domAbort).includes("message") &&
		Object.getOwnPropertySymbols(domAbort).length === 0,
);

// --- Event ---
const e = new Event("test", { cancelable: true, bubbles: true });
check("event type", e.type === "test");
const trustedDescriptor = Object.getOwnPropertyDescriptor(e, "isTrusted");
check(
	"script Event has shared own isTrusted accessor",
	e.isTrusted === false &&
		typeof trustedDescriptor.get === "function" &&
		trustedDescriptor.get ===
			Object.getOwnPropertyDescriptor(new Event("other"), "isTrusted").get,
);
check("event cancelable", e.cancelable === true);
check("event bubbles", e.bubbles === true);
check("defaultPrevented false", e.defaultPrevented === false);
e.preventDefault();
check("preventDefault", e.defaultPrevented === true);
const e2 = new Event("x"); // not cancelable
e2.preventDefault();
check("preventDefault no-op when not cancelable", e2.defaultPrevented === false);
let eventWithoutNewThrows = false;
try {
	Event("x");
} catch (error) {
	eventWithoutNewThrows = error instanceof TypeError;
}
check("Event requires new", eventWithoutNewThrows);
check(
	"Event initializes legacy state",
	e2.target === null &&
		e2.srcElement === null &&
		e2.currentTarget === null &&
		e2.eventPhase === Event.NONE &&
		e2.returnValue === true &&
		e2.timeStamp > 0 &&
		typeof e2.initEvent === "function",
);
const custom = new CustomEvent("custom", { detail: 54, cancelable: true });
check(
	"CustomEvent extends Event",
	custom instanceof Event && custom.detail === 54 && custom.cancelable,
);

// --- EventTarget ---
const et = new EventTarget();
let fired = 0;
let lastTarget = null;
const listener = (ev) => {
	fired++;
	lastTarget = ev.target;
};
et.addEventListener("a", listener);
et.addEventListener("a", listener); // duplicate: ignored
check("dispatch returns true", et.dispatchEvent(new Event("a")) === true);
check("listener fired once (dedup)", fired === 1);
check("event.target set", lastTarget === et);
et.removeEventListener("a", listener);
et.dispatchEvent(new Event("a"));
check("removeEventListener", fired === 1);

let onceCount = 0;
et.addEventListener("b", () => onceCount++, { once: true });
et.dispatchEvent(new Event("b"));
et.dispatchEvent(new Event("b"));
check("once listener", onceCount === 1);

let nestedOnceCount = 0;
et.addEventListener(
	"nested-once",
	() => {
		nestedOnceCount++;
		et.dispatchEvent(new Event("nested-once"));
	},
	{ once: true },
);
et.dispatchEvent(new Event("nested-once"));
check("once listener removed before nested dispatch", nestedOnceCount === 1);

const mutationOrder = [];
const mutationTarget = new EventTarget();
const removedAndReadded = () => mutationOrder.push("second");
mutationTarget.addEventListener(
	"mutation",
	() => {
		mutationOrder.push("first");
		mutationTarget.removeEventListener("mutation", removedAndReadded);
		mutationTarget.addEventListener("mutation", removedAndReadded);
	},
	{ once: true },
);
mutationTarget.addEventListener("mutation", removedAndReadded);
mutationTarget.dispatchEvent(new Event("mutation"));
mutationTarget.dispatchEvent(new Event("mutation"));
check(
	"dispatch skips removed snapshot listeners",
	mutationOrder.join() === "first,second",
);

// preventDefault via a listener makes dispatchEvent return false.
et.addEventListener("c", (ev) => ev.preventDefault());
check(
	"dispatch returns false when prevented",
	et.dispatchEvent(new Event("c", { cancelable: true })) === false,
);

// --- AbortController / AbortSignal ---
const ac = new AbortController();
check("signal not aborted", ac.signal.aborted === false);
check("signal instanceof AbortSignal", ac.signal instanceof AbortSignal);
check("signal instanceof EventTarget", ac.signal instanceof EventTarget);

let abortFired = 0;
let abortTrusted = false;
let abortEvent;
ac.signal.addEventListener("abort", (event) => {
	abortFired++;
	abortTrusted = event.isTrusted;
	abortEvent = event;
});
let onabortFired = 0;
ac.signal.onabort = () => onabortFired++;
ac.abort("boom");
check("aborted", ac.signal.aborted === true);
check("reason", ac.signal.reason === "boom");
check("abort listener fired", abortFired === 1);
check("abort event is trusted", abortTrusted);
new EventTarget().dispatchEvent(abortEvent);
check("script redispatch clears trusted state", abortEvent.isTrusted === false);
check("onabort fired", onabortFired === 1);
ac.abort("again");
check("second abort is a no-op", ac.signal.reason === "boom" && abortFired === 1);

let threw = false;
try {
	ac.signal.throwIfAborted();
} catch (err) {
	threw = err === "boom";
}
check("throwIfAborted throws reason", threw);

const notAborted = new AbortController();
let didThrow = false;
try {
	notAborted.signal.throwIfAborted();
} catch (err) {
	didThrow = true;
}
check("throwIfAborted no-op when live", didThrow === false);

// Static AbortSignal.abort.
const sa = AbortSignal.abort("static-reason");
check("static abort aborted", sa.aborted === true && sa.reason === "static-reason");
const sad = AbortSignal.abort();
check(
	"static abort default reason is AbortError DOMException",
	sad.aborted === true &&
		sad.reason instanceof DOMException &&
		sad.reason.name === "AbortError" &&
		sad.reason.message === "This operation was aborted" &&
		sad.reason.code === DOMException.ABORT_ERR,
);

const defaultController = new AbortController();
defaultController.abort();
check(
	"controller default reason is AbortError DOMException",
	defaultController.signal.reason instanceof DOMException &&
		defaultController.signal.reason.name === "AbortError" &&
		defaultController.signal.reason.code === 20,
);

// Static AbortSignal.any.
const alreadyFirst = AbortSignal.abort("first");
const alreadySecond = AbortSignal.abort("second");
const alreadyAny = AbortSignal.any([alreadyFirst, alreadySecond]);
check(
	"any uses first already-aborted reason",
	alreadyAny.aborted === true && alreadyAny.reason === "first",
);

const laterFirst = new AbortController();
const laterSecond = new AbortController();
const laterAny = AbortSignal.any([laterFirst.signal, laterSecond.signal]);
let laterFired = 0;
laterAny.addEventListener("abort", () => laterFired++);
laterSecond.abort("later-second");
laterFirst.abort("later-first");
check(
	"any follows first later abort",
	laterAny.aborted && laterAny.reason === "later-second" && laterFired === 1,
);

const propagationSource = new AbortController();
let propagationAny;
let dependentWasAbortedInSourceHandler = false;
propagationSource.signal.addEventListener("abort", (event) => {
	dependentWasAbortedInSourceHandler = propagationAny.aborted;
	event.stopImmediatePropagation();
});
propagationAny = AbortSignal.any([propagationSource.signal]);
propagationSource.abort("cannot-be-stopped");
check(
	"any propagation precedes and survives source event handlers",
	dependentWasAbortedInSourceHandler && propagationAny.reason === "cannot-be-stopped",
);

const emptyAny = AbortSignal.any([]);
check(
	"any empty iterable stays live",
	emptyAny.aborted === false && emptyAny.reason === undefined,
);

const lifetimeSource = new AbortController();
let lifetimeFired = 0;
(function installDependent() {
	const dependent = AbortSignal.any([lifetimeSource.signal]);
	dependent.addEventListener("abort", () => lifetimeFired++);
})();
for (let i = 0; i < 100; i++) ({ index: i });
lifetimeSource.abort("retained");
check("any source retains dependent signal", lifetimeFired === 1);

let nonIterableThrew = false;
try {
	AbortSignal.any(1);
} catch (err) {
	nonIterableThrew = err instanceof TypeError;
}
check("any rejects non-iterable", nonIterableThrew);

let wrongTypeThrew = false;
try {
	AbortSignal.any([new AbortController().signal, new EventTarget()]);
} catch (err) {
	wrongTypeThrew = err instanceof TypeError;
}
check("any rejects non-signal element", wrongTypeThrew);

const iterationError = { marker: "iteration-error" };
let preservedIterationError = false;
try {
	AbortSignal.any({
		[Symbol.iterator]() {
			return {
				next() {
					throw iterationError;
				},
			};
		},
	});
} catch (err) {
	preservedIterationError = err === iterationError;
}
check("any preserves iteration error", preservedIterationError);

let iteratorClosed = false;
let typeErrorAfterAborted = false;
try {
	AbortSignal.any({
		[Symbol.iterator]() {
			let index = 0;
			return {
				next() {
					if (index++ === 0) return { value: alreadyFirst, done: false };
					if (index === 2) return { value: {}, done: false };
					return { value: undefined, done: true };
				},
				return() {
					iteratorClosed = true;
					return { value: undefined, done: true };
				},
			};
		},
	});
} catch (err) {
	typeErrorAfterAborted = err instanceof TypeError;
}
check(
	"any validates full sequence and closes iterator",
	typeErrorAfterAborted && iteratorClosed,
);

// --- async: AbortSignal.timeout finalizes the run ---
const ts = AbortSignal.timeout(10);
check("timeout not yet aborted", ts.aborted === false);
ts.addEventListener("abort", () => {
	check("timeout aborted", ts.aborted === true);
	check(
		"timeout reason is TimeoutError DOMException",
		ts.reason instanceof DOMException &&
			ts.reason.name === "TimeoutError" &&
			ts.reason.message === "The operation was aborted due to timeout" &&
			ts.reason.code === DOMException.TIMEOUT_ERR,
	);
	let passed = 0;
	for (const [name, ok] of results) {
		if (ok) passed++;
		else console.log("FAIL: " + name);
	}
	console.log("RESULT " + passed + "/" + results.length);
});
