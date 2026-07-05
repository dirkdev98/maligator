// Event / EventTarget / AbortController / AbortSignal acceptance fixture.
//   node scripts/webtest.ts tests/local/events.js
// Sync checks run first; AbortSignal.timeout (async, via the event loop) finalizes
// the run and prints RESULT from its abort listener.

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}

// --- Event ---
const e = new Event("test", { cancelable: true, bubbles: true });
check("event type", e.type === "test");
check("event cancelable", e.cancelable === true);
check("event bubbles", e.bubbles === true);
check("defaultPrevented false", e.defaultPrevented === false);
e.preventDefault();
check("preventDefault", e.defaultPrevented === true);
const e2 = new Event("x"); // not cancelable
e2.preventDefault();
check("preventDefault no-op when not cancelable", e2.defaultPrevented === false);

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

// preventDefault via a listener makes dispatchEvent return false.
et.addEventListener("c", (ev) => ev.preventDefault());
check("dispatch returns false when prevented", et.dispatchEvent(new Event("c", { cancelable: true })) === false);

// --- AbortController / AbortSignal ---
const ac = new AbortController();
check("signal not aborted", ac.signal.aborted === false);
check("signal instanceof AbortSignal", ac.signal instanceof AbortSignal);
check("signal instanceof EventTarget", ac.signal instanceof EventTarget);

let abortFired = 0;
ac.signal.addEventListener("abort", () => abortFired++);
let onabortFired = 0;
ac.signal.onabort = () => onabortFired++;
ac.abort("boom");
check("aborted", ac.signal.aborted === true);
check("reason", ac.signal.reason === "boom");
check("abort listener fired", abortFired === 1);
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
check("static abort default reason is Error", sad.aborted === true && sad.reason instanceof Error);

// --- async: AbortSignal.timeout finalizes the run ---
const ts = AbortSignal.timeout(10);
check("timeout not yet aborted", ts.aborted === false);
ts.addEventListener("abort", () => {
	check("timeout aborted", ts.aborted === true);
	check("timeout reason is Error", ts.reason instanceof Error);
	let passed = 0;
	for (const [name, ok] of results) {
		if (ok) passed++;
		else console.log("FAIL: " + name);
	}
	console.log("RESULT " + passed + "/" + results.length);
});
