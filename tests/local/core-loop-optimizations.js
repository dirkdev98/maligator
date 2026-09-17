let passed = 0;

function check(name, condition) {
	if (!condition) throw new Error(`FAIL ${name}`);
	passed++;
}

function nestedControl(limit) {
	let total = 0;
	outer: for (let i = 0; i < limit; i++) {
		if (i === 4) break outer;
		for (let j = 0; j < 5; j++) {
			if (j === 1) continue;
			total += i * 4 + j;
		}
	}
	return total;
}
check("nested break and continue", nestedControl(20) === 132);

function descending() {
	let total = 0;
	for (let i = 10; i > 0; i--) total += i;
	return total;
}
check("descending induction", descending() === 55);

function reducedRemainderAndComparison() {
	let total = 0;
	for (let i = 0; i < 10; i++) {
		if (i >= 0 && i < 10) total += i % 16;
	}
	return total;
}
check(
	"range comparison and remainder strength reduction",
	reducedRemainderAndComparison() === 45,
);

function denseSum(values) {
	let total = 0;
	for (let i = 0; i < values.length; i++) total += values[i];
	return total;
}
check("length-bounded dense access", denseSum([3, 5, 7]) === 15);

function mutatingLength(values) {
	let total = 0;
	for (let i = 0; i < values.length; i++) {
		total += values[i];
		if (i === 0) values.push(11);
	}
	return `${total}:${values.length}`;
}
check("length mutation stays observable", mutatingLength([1, 2]) === "14:3");

function shrinkBeforeAccess() {
	const values = [3, 5];
	let missing = 0;
	for (let index = 0; index < values.length; index++) {
		values.length = 0;
		if (values[index] === undefined) missing++;
	}
	return missing;
}
check("shrunk length before access", shrinkBeforeAccess() === 1);

function inheritedHoleyLoop() {
	Object.defineProperty(Array.prototype, "1", {
		configurable: true,
		get() {
			return 7;
		},
	});
	const values = [3, , 5];
	let total = 0;
	for (let index = 0; index < values.length; index++) total += values[index];
	delete Array.prototype[1];
	return total;
}
check("inherited hole in indexed loop", inheritedHoleyLoop() === 15);

function preservesNegativeZero() {
	for (let i = -0; i < 1; i++) return Object.is(i, -0);
	return false;
}
check("negative zero seed", preservesNegativeZero());

function crossesSafeIntegerBoundary() {
	let count = 0;
	let final = 0;
	for (let i = Number.MAX_SAFE_INTEGER - 1; i <= Number.MAX_SAFE_INTEGER; i++) {
		count++;
		final = i + 1;
	}
	return `${count}:${final}`;
}
check("safe-integer boundary", crossesSafeIntegerBoundary() === "2:9007199254740992");

function int32Range(flag) {
	const value = (flag ? 0x7fffffff : -0x80000000) | 0;
	return `${value < 0x80000000}:${value >= -0x80000000}:${value < 0x7fffffff}`;
}
check("int32 upper range", int32Range(true) === "true:true:false");
check("int32 lower range", int32Range(false) === "true:true:true");

function protectedReads() {
	let reads = 0;
	let total = 0;
	const source = {
		get value() {
			reads++;
			if (reads === 2) throw new Error("second");
			return 3;
		},
	};
	for (let i = 0; i < 3; i++) {
		try {
			total += source.value;
		} catch (error) {
			total += error.message.length;
		}
	}
	return `${total}:${reads}`;
}
check("protected loop effects", protectedReads() === "12:3");

function* scaledGenerator(limit) {
	for (let i = 0; i < limit; i++) yield i * 4;
}
const iterator = scaledGenerator(3);
check("generator first", iterator.next().value === 0);
check("generator second", iterator.next().value === 4);
check("generator third", iterator.next().value === 8);
check("generator completion", iterator.next().done === true);

let partialSideEffect = 0;
function partialExpression(flag) {
	let total = 0;
	for (let i = 0; i < 3; i++) {
		if (flag) partialSideEffect = Math.sin(i);
		else partialSideEffect = Math.cos(i);
		total += Math.sin(i);
	}
	return total;
}
const expectedSine = Math.sin(0) + Math.sin(1) + Math.sin(2);
check("partial expression true path", partialExpression(true) === expectedSine);
check("partial true branch effect", partialSideEffect === Math.sin(2));
check("partial expression false path", partialExpression(false) === expectedSine);
check("partial false branch effect", partialSideEffect === Math.cos(2));

function stringChecksum(value) {
	let total = 0;
	for (let i = 0; i < value.length; i++) total += value.charCodeAt(i);
	return total;
}
check("bounded primitive string", stringChecksum("Loop") === 410);

const originalCharCodeAt = String.prototype.charCodeAt;
String.prototype.charCodeAt = function (position) {
	return this.length + position;
};
check("bounded String method mutation fallback", stringChecksum("AB") === 5);
String.prototype.charCodeAt = originalCharCodeAt;

check("checks ran", passed === 20);
console.log("core-loop-optimizations PASS");
