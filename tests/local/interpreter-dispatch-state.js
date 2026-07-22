let checks = 0;

function check(condition, message) {
	if (!condition) throw new Error("FAIL " + message);
	checks++;
}

function leafConstants(seed) {
	let moved = seed;
	const integer = 17;
	const floating = 1.25;
	const boolean = true;
	const text = "leaf";
	const bigint = 9n;
	const missing = undefined;
	const nil = null;
	if (seed < 0) moved = integer;

	check(moved === seed, "move and branch merge");
	check(integer + floating === 18.25, "number constants");
	check(boolean && !false, "boolean constants and unary not");
	check(text === "leaf", "string constant");
	check(bigint === 9n, "bigint constant");
	check(missing === undefined && nil === null, "undefined and null constants");
	check(typeof moved === "number" && typeof text !== "object", "typeof comparisons");
	return moved + integer;
}

check(leafConstants(5) === 22, "leaf result");

let loopChecksum = 0;
for (let i = 0; i < 200; i++) {
	if ((i & 1) === 0) loopChecksum += i;
	else loopChecksum -= i;
}
check(loopChecksum === -100, "forward branches and backedges");

let reentries = 0;
function nestedCall(value) {
	reentries++;
	return value + 1;
}

const coercer = {
	valueOf() {
		const evaluated = eval("20 + 1");
		return nestedCall(evaluated);
	},
};
check(coercer + 1 === 23 && reentries === 1, "coercion reentry and eval splice");

const getterHolder = {};
Object.defineProperty(getterHolder, "value", {
	get() {
		return nestedCall(30);
	},
});
check(getterHolder.value === 31 && reentries === 2, "getter reentry");

const marker = {};
let caught = false;
try {
	const retained = { tag: "retained" };
	const throwing = {
		valueOf() {
			check(retained.tag === "retained", "throw boundary root");
			throw marker;
		},
	};
	throwing + 1;
} catch (error) {
	caught = error === marker;
}
check(caught, "throw and catch instruction pointer");

const rooted = [];
for (let i = 0; i < 300; i++) {
	rooted.push({ index: i, text: "root-" + i });
	if (typeof gc === "function" && (i & 31) === 0) gc();
}
check(rooted[0].text === "root-0" && rooted[299].index === 299, "GC roots");

function* suspendable(seed) {
	const before = { value: seed, label: "yielded" };
	const resumed = yield before;
	const after = { value: resumed + before.value };
	return after;
}

const iterator = suspendable(4);
const yielded = iterator.next();
check(yielded.value.label === "yielded" && !yielded.done, "yield boundary");
const returned = iterator.next(6);
check(returned.value.value === 10 && returned.done, "generator resume boundary");

async function resumeAcrossAwait(value) {
	const before = { value, label: "awaited" };
	const resumed = (await value) + 1;
	const after = { value: resumed + before.value, label: before.label };
	return after;
}

resumeAcrossAwait(6).then((result) => {
	check(result.value === 13 && result.label === "awaited", "async resume boundary");
	console.log("interpreter-dispatch-state PASS " + checks);
});
