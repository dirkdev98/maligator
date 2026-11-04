/* oxlint-disable no-console -- The fixture reports numeric loan and snapshot behavior. */
import {
	numeric_i8,
	numeric_u8,
	numeric_i16,
	numeric_u16,
	numeric_i32,
	numeric_u32,
	numeric_i64,
	i64Async,
	numeric_u64,
	numeric_f32,
	numeric_f64,
	sumAsync,
	numeric_dot,
	numeric_independent,
	dotAsync,
	numeric_visit,
	visitAsync,
	numeric_mutable,
	numeric_bool,
	numeric_calls,
	numeric_reset,
} from "maligator:ffi/numeric";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
async function rejects(run: () => unknown): Promise<void> {
	numeric_reset();
	let caught: unknown;
	try {
		await run();
	} catch (error) {
		caught = error;
	}
	check(caught instanceof TypeError, `expected TypeError, got ${String(caught)}`);
	check(numeric_calls() === 0, "invalid numeric input reached C");
}

check(numeric_i8(new Int8Array([-4, 7])) === 3, "int8");
check(numeric_u8(new Uint8Array([2, 7])) === 9, "uint8");
check(numeric_i16(new Int16Array([-400, 700])) === 300, "int16");
check(numeric_u16(new Uint16Array([40000, 700])) === 40700, "uint16");
check(numeric_i32(new Int32Array([-400000, 700000])) === 300000, "int32");
check(numeric_u32(new Uint32Array([4000000000, 7])) === 4000000007, "uint32");
check(
	numeric_i64(new BigInt64Array([-9007199254740993n, 7n])) === -9007199254740986n,
	"int64",
);
check(
	(await i64Async(new BigInt64Array([9007199254740993n, 7n]))) === 9007199254741000n,
	"async int64",
);
check(
	numeric_u64(new BigUint64Array([18014398509481985n, 7n])) === 18014398509481992n,
	"uint64",
);
check(numeric_f32(new Float32Array([0.25, 0.5])) === 0.75, "float32");

for (const sum of [numeric_f64, sumAsync]) {
	for (const values of [
		[2, 3],
		[0.25, 0.5],
		[2, 0.5, -3],
		[0.5, 2, -3],
	])
		check(
			(await sum(values)) === values.reduce((total, value) => total + value, 0),
			"number-array snapshots preserve integer, double and mixed values",
		);
	check(
		(await sum(Object.freeze([2, 3]))) === 5 && (await sum(Object.seal([2, 3]))) === 5,
		"sealed and frozen packed arrays remain readable",
	);
	check(
		Number.isNaN(await sum([NaN])) && (await sum([Infinity])) === Infinity,
		"numeric snapshots preserve non-finite values",
	);
	let coercions = 0;
	await rejects(() =>
		sum([
			2,
			{
				valueOf() {
					coercions++;
					return 3;
				},
			},
		] as unknown as Array<number>),
	);
	check(coercions === 0, "strict numeric conversion does not coerce objects");
	const late: Array<unknown> = Array.from({ length: 65 }, (_, index) => index + 0.25);
	late[late.length - 1] = {};
	await rejects(() => sum(late as Array<number>));
	for (const invalid of [undefined, null, false]) {
		for (const position of [32, 64]) {
			const values: Array<unknown> = Array.from(
				{ length: 65 },
				(_, index) => index + 0.25,
			);
			values[position] = invalid;
			await rejects(() => sum(values as Array<number>));
		}
	}
	check(
		Number.isNaN(await sum([-Infinity, NaN])),
		"mixed special doubles remain Number values",
	);
	let laterReads = 0;
	const invalid = ["bad", 3];
	Object.defineProperty(invalid, "1", {
		get() {
			laterReads++;
			return 3;
		},
	});
	await rejects(() => sum(invalid as unknown as Array<number>));
	check(laterReads === 0, "numeric rejection precedes later element getters");
	const holes = [2, 3, 4];
	Reflect.deleteProperty(holes, "1");
	const prototype = Object.create(Array.prototype) as object;
	Object.defineProperty(prototype, "1", {
		get() {
			holes[2] = 8;
			return 3;
		},
	});
	Object.setPrototypeOf(holes, prototype);
	check(
		(await sum(holes)) === 13,
		"inherited hole getters can change later numeric elements",
	);
	const shrinking = [2, 3];
	Object.defineProperty(shrinking, "0", {
		get() {
			shrinking.length = 1;
			return 2;
		},
	});
	await rejects(() => sum(shrinking));
	const reads: Array<string> = [];
	const proxy = new Proxy([2, 3], {
		get(target, key, receiver) {
			if (key === "0" || key === "1") reads.push(key);
			return Reflect.get(target, key, receiver) as unknown;
		},
	});
	check(
		(await sum(proxy)) === 5 && reads.join("") === "01",
		"Array proxies retain ordered element reads",
	);
}
check(
	Object.is(
		numeric_visit([-0], () => {}),
		-0,
	),
	"double snapshots preserve negative zero bits",
);
{
	const source = [2];
	const pending = visitAsync(source, () => {});
	source[0] = 100;
	check(
		(await pending) === 4,
		"async numeric arrays are copied before later JS mutation",
	);
}

class Vector extends Float64Array {}
{
	const outer = Array.from({ length: 65 }, () => 2);
	let inner = 0;
	check(
		numeric_visit(outer, () => {
			outer[0] = 100;
			inner = numeric_f64(Array.from({ length: 65 }, () => 7));
		}) === 4 && inner === 455,
		"reentrant numeric callbacks preserve the outer snapshot",
	);
	let failed = false;
	try {
		numeric_visit(outer, () => {
			numeric_f64(Array.from({ length: 65 }, () => 11));
			throw new RangeError("nested numeric callback");
		});
	} catch (error) {
		failed = error instanceof RangeError;
	}
	check(
		failed && numeric_f64(outer) === 228,
		"callback failure releases numeric scratch for subsequent calls",
	);
}
{
	const left = Array.from({ length: 65 }, (_, index) => index + 0.25);
	const expected = left.reduce((sum, value) => sum + value, 0);
	const right = Array.from({ length: left.length }, () => 1);
	let inner = 0;
	Object.defineProperty(right, 0, {
		get() {
			left.fill(100);
			inner = numeric_f64(Array.from({ length: 65 }, () => 3));
			return 1;
		},
	});
	check(
		numeric_dot(left, right) === expected && inner === 195,
		"later getters can reenter without overwriting earlier numeric snapshots",
	);
}
for (const length of [8192, 8193]) {
	const left = Array.from({ length }, () => 2),
		right = Array.from({ length }, () => 3);
	check(
		numeric_dot(left, right) === 6 * length,
		"large numeric snapshots retain heap fallback beyond scratch capacity",
	);
}
{
	const values = Array.from({ length: 65 }, () => 2);
	check(
		numeric_independent(values, values) === 11 && values[0] === 2,
		"aliased JavaScript arrays receive independent mutable native snapshots",
	);
}
for (const [leftCount, rightCount] of [
	[8, 65],
	[65, 8],
	[8, 8193],
] as const) {
	const left = Array.from({ length: leftCount }, () => 2),
		right = Array.from({ length: rightCount }, () => 3);
	check(
		numeric_independent(left, right) === 12 && left[0] === 2,
		"mixed inline and heap arguments keep numeric snapshots independent",
	);
}
for (const sum of [numeric_f64, sumAsync]) {
	const storage = new Float64Array([99, 2, 3, 101]);
	const view = storage.subarray(1, 3);
	Object.defineProperty(view, "length", { value: 999 });
	check(
		(await sum(view)) === 5 && storage[0] === 99 && storage[3] === 101,
		"offset view uses its internal extent",
	);
	check((await sum(new Vector([2, 3]))) === 5, "typed-array subclasses keep their brand");
	check(
		(await sum(new Float64Array())) === 0 &&
			(await sum(null)) === 0 &&
			(await sum([2, 3])) === 5,
		"empty, null, and ordinary arrays",
	);
	const frozen = (
		new Float64Array([2, 3]).buffer as ArrayBuffer & {
			transferToImmutable(): ArrayBuffer;
		}
	).transferToImmutable();
	check(
		(await sum(new Float64Array(frozen))) === 5,
		"const numeric inputs accept immutable storage",
	);
	for (const invalid of [
		new Float32Array(2),
		new Int32Array(4),
		new Uint8ClampedArray(16),
		new DataView(new ArrayBuffer(16)),
		new ArrayBuffer(16),
		new Float64Array(new SharedArrayBuffer(16)),
	]) {
		await rejects(() => sum(invalid as unknown as ReadonlyArray<number>));
	}
	let traps = 0;
	const proxy = new Proxy(new Float64Array(2), {
		get() {
			traps++;
			throw new Error("typed-array proxy trap");
		},
	});
	await rejects(() => sum(proxy));
	check(traps === 0, "rejected typed-array proxies run no traps");
	const detached = new Float64Array(2);
	detached.buffer.transfer();
	await rejects(() => sum(detached));
	const bounded = new ArrayBuffer(24, { maxByteLength: 32 });
	const outside = new Float64Array(bounded, 8, 2);
	bounded.resize(8);
	await rejects(() => sum(outside));
}

for (const dot of [numeric_dot, dotAsync]) {
	check(
		(await dot(new Float64Array([2, 3]), new Float64Array([5, 7]))) === 31,
		"matching shared view counts",
	);
	await rejects(() => dot(new Float64Array(1), new Float64Array(2)));
	const detached = new Float64Array(2);
	const detaching = [1, 1];
	Object.defineProperty(detaching, "0", {
		get() {
			detached.buffer.transfer();
			return 1;
		},
	});
	await rejects(() => dot(detached, detaching));
	const buffer = new ArrayBuffer(16, { maxByteLength: 24 });
	const tracking = new Float64Array(buffer);
	tracking.set([2, 3]);
	const growing = [1, 1, 1];
	Object.defineProperty(growing, "0", {
		get() {
			buffer.resize(24);
			tracking[2] = 5;
			return 1;
		},
	});
	check(
		(await dot(tracking, growing)) === 10,
		"later getters establish the final numeric extent",
	);
}

const loanBuffer = new ArrayBuffer(16, { maxByteLength: 24 });
const loan = new Float64Array(loanBuffer);
loan.set([2, 3]);
let blocked = 0;
check(
	numeric_visit(loan, () => {
		loan[0] = 7;
		try {
			loanBuffer.resize(24);
		} catch (error) {
			if (error instanceof TypeError) blocked++;
		}
		try {
			loanBuffer.transfer();
		} catch (error) {
			if (error instanceof TypeError) blocked++;
		}
	}) === 9 && blocked === 2,
	"C sees live numeric writes while structural changes are pinned",
);
loanBuffer.resize(24);
check(loanBuffer.transfer().byteLength === 24, "successful calls release numeric pins");
const failed = new Float64Array([2]);
const failure = new Error("numeric callback failure");
let caught: unknown;
try {
	numeric_visit(failed, () => {
		throw failure;
	});
} catch (error) {
	caught = error;
}
check(
	caught === failure && failed.buffer.transfer().byteLength === 8,
	"failed callbacks preserve the exception and release pins",
);

const copied = new Float64Array([2]);
const pending = visitAsync(copied, () => {});
copied[0] = 100;
check(
	copied.buffer.transfer().byteLength === 8 && (await pending) === 4,
	"async work owns a snapshot before submission returns",
);
const array = [2];
check(
	numeric_visit(array, () => {
		array[0] = 7;
	}) === 4,
	"ordinary arrays retain copy semantics",
);
const writable = [2];
check(
	numeric_mutable(writable) === 3 && writable[0] === 2,
	"mutable pointers keep array copies",
);
await rejects(() =>
	numeric_mutable(new Float64Array([2]) as unknown as ReadonlyArray<number>),
);
check(numeric_bool([true]) === true, "boolean arrays keep element conversion");
await rejects(() =>
	numeric_bool(new Uint8Array([1]) as unknown as ReadonlyArray<boolean>),
);
console.log("numeric views passed");
