import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

const iterations = 500_000;
const parametersPerCall = 4;
const warmupIterations = 10_000;
const textValues = ["alpha", "bravo", "charlie", "delta"];

const database = new DatabaseSync(":memory:");
const unbound = database.prepare("SELECT 1");
const numbers = database.prepare("SELECT ? AS a, ? AS b, ? AS c, ? AS d");
const text = database.prepare("SELECT ? AS a, ? AS b, ? AS c, ? AS d");

const numberProbe = numbers.get(3, 5, 7, 11);
const textProbe = text.get(...textValues);
if (
	numberProbe.a !== 3 ||
	numberProbe.d !== 11 ||
	textProbe.a !== "alpha" ||
	textProbe.d !== "delta"
) {
	throw new Error("node:sqlite binding benchmark probe failed");
}

for (let index = 0; index < warmupIterations; index++) {
	unbound.run();
	numbers.run(index, index + 1, index + 2, index + 3);
	text.run(...textValues);
}

let start = performance.now();
for (let index = 0; index < iterations; index++) unbound.run();
const unboundMs = performance.now() - start;

start = performance.now();
for (let index = 0; index < iterations; index++) {
	numbers.run(index, index + 1, index + 2, index + 3);
}
const numberMs = performance.now() - start;

start = performance.now();
for (let index = 0; index < iterations; index++) text.run(...textValues);
const textMs = performance.now() - start;

database.close();
console.log(
	JSON.stringify({
		iterations,
		parametersPerCall,
		unboundMs,
		numberMs,
		textMs,
	}),
);
