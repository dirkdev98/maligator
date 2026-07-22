let checks = 0;

function check(condition, message) {
	if (!condition) throw new Error(`FAIL ${message}`);
	checks++;
}

const falsyValues = [undefined, null, false, 0, -0, NaN, "", 0n];
for (const value of falsyValues) {
	let selected = "truthy";
	if (value) selected = "falsy";
	check(selected === "truthy", `falsy value ${String(value)}`);
}

const truthyValues = [true, 1, -1, Infinity, "value", 1n, {}, [], function () {}];
for (const value of truthyValues) {
	let selected = "falsy";
	if (value) selected = "truthy";
	check(selected === "truthy", `truthy value ${String(value)}`);
}

let whileCount = 0;
let whileSum = 0;
while (whileCount < 64) {
	whileSum += whileCount++;
}
check(whileCount === 64 && whileSum === 2016, "unconditional loop backedge");

let doCount = 0;
let doSum = 0;
do {
	doSum += doCount++;
} while (doCount < 64);
check(doCount === 64 && doSum === 2016, "conditional loop backedge");

function throwAcrossBranch(condition) {
	try {
		if (condition) {
			throw new Error("truthy branch");
		}
		throw new Error("falsy branch");
	} catch (error) {
		return error.message;
	}
}

check(throwAcrossBranch(true) === "truthy branch", "truthy branch exception");
check(throwAcrossBranch(false) === "falsy branch", "falsy branch exception");

const evens = [];
const odds = [];
let allocationCount = 0;
do {
	const entry = { index: allocationCount, payload: `branch-${allocationCount}` };
	if ((allocationCount & 1) === 0) {
		evens.push(entry);
	} else {
		odds.push(entry);
	}
	allocationCount++;
} while (allocationCount < 200);

check(evens.length === 100 && odds.length === 100, "branch allocations retained");
for (let i = 0; i < 100; i++) {
	check(evens[i].index === i * 2, `even branch object ${i}`);
	check(odds[i].payload === `branch-${i * 2 + 1}`, `odd branch object ${i}`);
}

check(checks === 222, "all branch checks ran");
console.log("interpreter-branches PASS");
