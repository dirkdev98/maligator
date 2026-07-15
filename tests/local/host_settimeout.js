// End-to-end host event-loop test. Exercises
// setTimeout ordering (by delay), clearTimeout, extra-arg forwarding, microtask vs
// macrotask ordering, and a timer that schedules another timer. The runner
// (scripts/hosttest.ts) asserts the exact stdout sequence.
console.log("start");

setTimeout(() => console.log("t:100"), 100);
setTimeout(() => console.log("t:0"), 0);
setTimeout((a, b) => console.log("t:args " + a + " " + b), 20, "x", "y");

const cancelled = setTimeout(() => console.log("t:CANCELLED-SHOULD-NOT-PRINT"), 30);
clearTimeout(cancelled);

setTimeout(() => {
	console.log("t:50 schedules another");
	setTimeout(() => console.log("t:nested"), 10);
	Promise.resolve().then(() => console.log("t:50 microtask"));
}, 50);

Promise.resolve().then(() => console.log("microtask-1"));

console.log("end");
