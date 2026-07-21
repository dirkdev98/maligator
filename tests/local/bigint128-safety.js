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
check("addition wraps", MAX + 1n === MIN);
check("subtraction wraps", MIN - 1n === MAX);
check("multiplication wraps", MAX * 2n === -2n);
check("minimum negation wraps", -MIN === MIN);
check("bitwise tails use fixed bits", ~MIN === MAX && (MIN | 1n) === MIN + 1n);

check("left shift reaches sign bit", 1n << 127n === MIN);
check("left shift at width clears", 1n << 128n === 0n);
check("left shift beyond width clears", MAX << 1000n === 0n);
check("negative left count shifts right", 8n << -1n === 4n && -8n << -1n === -4n);
check("minimum left count is safe", 1n << MIN === 0n && -1n << MIN === -1n);
check("right shift sign fills", MIN >> 127n === -1n && -1n >> 128n === -1n);
check("right shift at width clears positive", MAX >> 128n === 0n);
check("negative right count shifts left", 1n >> -127n === MIN);
check("minimum right count is safe", 1n >> MIN === 0n);

check("minimum division wraps", MIN / -1n === MIN);
check("minimum remainder is zero", MIN % -1n === 0n);
check("ordinary division truncates", -7n / 3n === -2n && -7n % 3n === -1n);
check(
	"division by zero throws",
	throws(RangeError, () => 1n / 0n),
);

check("power reaches sign bit", 2n ** 127n === MIN);
check("power wraps at width", 2n ** 128n === 0n);
check("power multiplication wraps", MAX ** 2n === 1n);
check(
	"negative power throws",
	throws(RangeError, () => 2n ** -1n),
);

check("huge decimal literal wraps", 340282366920938463463374607431768211456n === 0n);
check("huge hex literal wraps", 0x100000000000000000000000000000000n === 0n);
check(
	"huge decimal string wraps",
	BigInt("340282366920938463463374607431768211457") === 1n,
);
check(
	"huge negative string wraps",
	BigInt("-340282366920938463463374607431768211457") === -1n,
);
check(
	"many-digit string wraps",
	BigInt(
		"100000000000000000000000000000000000000000000000000000000000000000000000000000000",
	) === 132435522674567342041261840258306146304n,
);
check("prefixed string wraps", BigInt("0x100000000000000000000000000000001") === 1n);
check(
	"invalid parse still throws",
	throws(SyntaxError, () => BigInt("0x")),
);

check("Number positive boundary wraps", BigInt(2 ** 127) === MIN);
check("Number negative boundary", BigInt(-(2 ** 127)) === MIN);
check("Number modulus wraps", BigInt(2 ** 128) === 0n);
check("huge integral Number wraps", BigInt(1.7976931348623157e308) === 0n);
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

check("asUintN approximation at width", BigInt.asUintN(128, MIN) === MIN);
check(
	"asIntN sign extends",
	BigInt.asIntN(127, (1n << 126n) + 1n) === -(1n << 126n) + 1n,
);
check("asN zero width", BigInt.asUintN(0, MAX) === 0n && BigInt.asIntN(0, MIN) === 0n);

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
