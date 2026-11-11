const checks = [];
const check = (name, condition) => {
	checks.push(condition);
	if (!condition) console.log("FAIL " + name);
};
const throws = (constructor, callback) => {
	try {
		callback();
		return false;
	} catch (error) {
		return error instanceof constructor;
	}
};

const MIN = BigInt("-170141183460469231731687303715884105728");
const MAX = BigInt("170141183460469231731687303715884105727");

check("minimum parses", MIN.toString() === "-170141183460469231731687303715884105728");
check("maximum parses", MAX.toString() === "170141183460469231731687303715884105727");
check("addition promotes", MAX + 1n === -MIN);
check("subtraction promotes", MIN - 1n === -MAX - 2n);
check(
	"multiplication promotes",
	(MAX * 2n).toString() === "340282366920938463463374607431768211454",
);
check(
	"minimum negation promotes",
	(-MIN).toString() === "170141183460469231731687303715884105728",
);
check("bitwise tails use sign extension", ~MIN === MAX && (MIN | 1n) === MIN + 1n);

check("left shift preserves positive sign", 1n << 127n === -MIN);
check(
	"left shift crosses native width",
	(1n << 128n).toString() === "340282366920938463463374607431768211456",
);
check("left shift retains high digits", (MAX << 1000n) >> 1000n === MAX);
check("negative left count shifts right", 8n << -1n === 4n && -8n << -1n === -4n);
check("minimum left count is safe", 1n << MIN === 0n && -1n << MIN === -1n);
check("right shift sign fills", MIN >> 127n === -1n && -1n >> 128n === -1n);
check("right shift at width clears positive", MAX >> 128n === 0n);
check("negative right count shifts left", 1n >> -127n === -MIN);
check(
	"oversized left shift rejects before allocation",
	throws(RangeError, () => 1n >> MIN),
);

check("minimum division promotes", MIN / -1n === -MIN);
check("minimum remainder is zero", MIN % -1n === 0n);
check("ordinary division truncates", -7n / 3n === -2n && -7n % 3n === -1n);
check(
	"division by zero throws",
	throws(RangeError, () => 1n / 0n),
);

check("power remains positive", 2n ** 127n === -MIN);
check(
	"power crosses native width",
	(2n ** 128n).toString() === "340282366920938463463374607431768211456",
);
check("power retains product digits", MAX ** 2n === (1n << 254n) - (1n << 128n) + 1n);
check(
	"negative power throws",
	throws(RangeError, () => 2n ** -1n),
);

check(
	"wide decimal literal",
	340282366920938463463374607431768211456n.toString() ===
		"340282366920938463463374607431768211456",
);
check(
	"wide hex literal",
	0x100000000000000000000000000000000n.toString(16) ===
		"100000000000000000000000000000000",
);
check(
	"wide decimal string",
	BigInt("340282366920938463463374607431768211457").toString() ===
		"340282366920938463463374607431768211457",
);
check(
	"wide negative string",
	BigInt("-340282366920938463463374607431768211457").toString() ===
		"-340282366920938463463374607431768211457",
);
check(
	"many-digit string",
	BigInt(
		"100000000000000000000000000000000000000000000000000000000000000000000000000000000",
	).toString() ===
		"100000000000000000000000000000000000000000000000000000000000000000000000000000000",
);
check(
	"prefixed wide string",
	BigInt("0x100000000000000000000000000000001").toString(16) ===
		"100000000000000000000000000000001",
);
check(
	"invalid parse still throws",
	throws(SyntaxError, () => BigInt("0x")),
);

check("Number positive boundary", BigInt(2 ** 127) === -MIN);
check("Number negative boundary", BigInt(-(2 ** 127)) === MIN);
check(
	"Number crosses native width",
	BigInt(2 ** 128).toString() === "340282366920938463463374607431768211456",
);
check(
	"maximum finite Number converts exactly",
	BigInt(1.7976931348623157e308) === (1n << 1024n) - (1n << 971n),
);
check(
	"ordinary integral Number is exact",
	BigInt(100000000000000000000) === 100000000000000000000n,
);
check(
	"fractional Number still throws",
	throws(RangeError, () => BigInt(1.5)),
);
check(
	"infinite Number still throws",
	throws(RangeError, () => BigInt(Infinity)),
);

check("asUintN retains the unsigned native width", BigInt.asUintN(128, MIN) === -MIN);
check(
	"asIntN sign extends",
	BigInt.asIntN(127, (1n << 126n) + 1n) === -(1n << 126n) + 1n,
);
check("asN zero width", BigInt.asUintN(0, MAX) === 0n && BigInt.asIntN(0, MIN) === 0n);

const bigintMap = new Map();
bigintMap.set(BigInt("64"), "first");
check("Map finds equal BigInt key", bigintMap.get(32n + 32n) === "first");
bigintMap.set(64n, "updated");
check(
	"Map updates equal BigInt key",
	bigintMap.size === 1 && bigintMap.get(BigInt("64")) === "updated",
);
bigintMap.set(BigInt("-170141183460469231731687303715884105728"), "minimum");
check("Map hashes full-width BigInt key", bigintMap.get(MIN + 0n) === "minimum");
check(
	"Map deletes equal BigInt key",
	bigintMap.delete(BigInt("64")) && !bigintMap.has(64n),
);

const bigintSet = new Set([BigInt("128"), 64n + 64n, 128n]);
check(
	"Set deduplicates equal BigInt keys",
	bigintSet.size === 1 && bigintSet.has(BigInt("128")),
);

const unsigned = new BigUint64Array(new SharedArrayBuffer(8));
unsigned[0] = 1n;
check("Atomics BigInt add returns old", Atomics.add(unsigned, 0, MAX) === 1n);
check("Atomics BigInt add wraps", unsigned[0] === 0n);
check("Atomics BigInt sub returns old", Atomics.sub(unsigned, 0, MIN) === 0n);
check("Atomics BigInt sub wraps", unsigned[0] === 0n);
unsigned[0] = 0xffffffffffffffffn;
check(
	"Atomics BigInt bitwise",
	Atomics.and(unsigned, 0, 0x5555555555555555n) === 0xffffffffffffffffn &&
		unsigned[0] === 0x5555555555555555n,
);
check(
	"Atomics BigInt type error",
	throws(TypeError, () => Atomics.add(unsigned, 0, 1)),
);

check(
	"unsigned right shift still throws",
	throws(TypeError, () => 1n >>> 1n),
);
check(
	"mixed arithmetic still throws",
	throws(TypeError, () => 1n + 1),
);

console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
