import * as self from "./module-loop-bindings.mjs";

let checks = 0;
function ok(name, condition) {
	if (!condition) throw new Error(`module-loop-bindings failure: ${name}`);
	checks++;
}

const limit = Number(globalThis.process?.argv?.[2] ?? 1000);

let sum = 0;
for (let i = 0; i < limit; i++) sum += (i * 3) % 7;
ok("integer sum", sum === 2999);

// A fractional quotient restarts the iteration after its first store, which the
// original loop then repeats from the iteration's start.
let restarted = 0;
for (let i = 0; i < 6; i++) {
	restarted += 1;
	restarted += (i * 6) / 4;
}
ok("restart after a store", restarted === 28.5);

let fraction = 0.5;
for (let i = 0; i < limit; i++) fraction += i % 3;
ok("fractional entry", fraction === 999.5);

let text = "a";
for (let i = 0; i < 3; i++) text += i;
ok("string entry", text === "a012");

let partial = 0;
for (let i = 0; i < limit; i++) {
	partial += i;
	if (partial > 50) break;
}
ok("break after a store", partial === 55);

let nested = 0;
for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) nested += i * j;
ok("nested loops", nested === 2025);

const values = new Float64Array([0.5, 1.25, 2, -0.75]);
let scaled = 0;
for (let i = 0; i < values.length; i++) scaled += values[i] * 2;
ok("typed array sum", scaled === 6);

let readEarly;
try {
	for (let i = 0; i < 2; i++) late += i;
} catch (error) {
	readEarly = error;
}
ok("dead zone", readEarly instanceof ReferenceError);
let late = 0;

export let exported = 0;
for (let i = 0; i < limit; i++) exported += i & 1;
ok("live export", self.exported === 500);

ok("check count", checks === 9);
console.log("module-loop-bindings PASS");
