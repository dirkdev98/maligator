let checks = 0;
function ok(name, condition) {
	if (!condition) throw new Error("closed-global-table failure: " + name);
	checks++;
}

const fastTable = {};
function fast(seed) {
	const key = seed & 7;
	const previous = fastTable[key];
	fastTable[key] = { value: seed };
	return (previous === undefined ? -1 : previous.value) + fastTable[key].value;
}

let checksum = 0;
for (let i = 0; i < 4000; i++) checksum += fast(i);
ok("bounded table checksum", checksum === 15964028);
ok("heap values remain rooted", fast(3999) === 7998);

const deoptTable = {};
function deopt(seed, name) {
	const key = seed & 3;
	deoptTable[key] = seed;
	const before = deoptTable[key];
	if (name !== undefined) {
		deoptTable[name] = seed + 10;
		return before + deoptTable[name] + deoptTable[key];
	}
	return before;
}
ok("fast value before unknown selector", deopt(2, undefined) === 2);
ok("unknown selector materializes", deopt(3, "other") === 19);
ok("post-deopt direct selector", deopt(6, undefined) === 6);

const undefinedTable = {};
function explicitUndefined(seed) {
	const key = seed & 1;
	const previous = undefinedTable[key];
	undefinedTable[key] = undefined;
	return previous;
}
ok("initial explicit undefined", explicitUndefined(1) === undefined);

const prototypeTable = {};
function prototypeAccess(seed) {
	const key = seed & 3;
	const previous = prototypeTable[key];
	prototypeTable[key] = seed;
	return previous;
}
ok("prototype table warm value", prototypeAccess(1) === undefined);

let inheritedOneGets = 0;
let inheritedOneSets = 0;
Object.defineProperty(Object.prototype, "1", {
	get() {
		inheritedOneGets++;
		return 99;
	},
	set() {
		inheritedOneSets++;
	},
	configurable: true,
});
ok(
	"explicit undefined materializes as own",
	explicitUndefined(1) === undefined && inheritedOneGets === 0 && inheritedOneSets === 0,
);
delete Object.prototype["1"];

let inheritedTwoSets = 0;
Object.defineProperty(Object.prototype, "2", {
	set(value) {
		inheritedTwoSets += value;
	},
	configurable: true,
});
ok(
	"protector deopt preserves inherited setter",
	prototypeAccess(2) === undefined && inheritedTwoSets === 2,
);
ok("materialized earlier own value", prototypeAccess(1) === 1);
delete Object.prototype["2"];

ok("check count", checks === 10);
console.log("closed-global-table PASS " + checks + "/" + checks);
