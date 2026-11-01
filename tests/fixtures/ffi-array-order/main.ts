/* oxlint-disable no-console -- The fixture reports native conversion behavior. */
import { array_sum, array_calls, array_reset } from "maligator:ffi/points";
import type { ArrayPoint } from "maligator:ffi/points";

function check(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

function invalid(): ArrayPoint {
	return { x: "invalid" as unknown as number, y: 0 };
}
function rejectsFirst(
	points: Array<ArrayPoint>,
	reads: { count: number },
	name: string,
): void {
	array_reset();
	let caught: unknown;
	try {
		array_sum(points);
	} catch (error) {
		caught = error;
	}
	check(
		caught instanceof TypeError,
		`${name}: expected the first conversion error, got ${String(caught)}`,
	);
	check(reads.count === 0, `${name}: later input was read`);
	check(array_calls() === 0, `${name}: invalid arguments reached C`);
}

const laterFailure = new Error("later input getter");
const getterReads = { count: 0 };
rejectsFirst(
	[
		invalid(),
		{
			get x(): number {
				getterReads.count++;
				throw laterFailure;
			},
			y: 0,
		},
	],
	getterReads,
	"record getter",
);

const proxyReads = { count: 0 };
const recordProxy = new Proxy(
	{ x: 1, y: 2 },
	{
		get() {
			proxyReads.count++;
			throw laterFailure;
		},
	},
);
rejectsFirst([invalid(), recordProxy], proxyReads, "record proxy");

const inheritedReads = { count: 0 };
const sparse = [invalid(), { x: 1, y: 2 }];
Reflect.deleteProperty(sparse, "1");
const prototype = Object.create(Array.prototype) as Array<ArrayPoint>;
Object.defineProperty(prototype, "1", {
	get() {
		inheritedReads.count++;
		throw laterFailure;
	},
});
Object.setPrototypeOf(sparse, prototype);
rejectsFirst(sparse, inheritedReads, "inherited array getter");

const arrayReads = { count: 0 };
const arrayProxy = new Proxy([invalid(), { x: 1, y: 2 }], {
	get(target, key, receiver): unknown {
		if (key === "1") {
			arrayReads.count++;
			throw laterFailure;
		}
		return Reflect.get(target, key, receiver);
	},
});
rejectsFirst(arrayProxy, arrayReads, "array proxy");

const replaced: Array<ArrayPoint> = [
	{
		get x() {
			replaced[1] = { x: 7, y: 11 };
			return 2;
		},
		y: 3,
	},
	{ x: 100, y: 200 },
];
check(array_sum(replaced) === 23, "later elements observe earlier getter mutations");

const shortened: Array<ArrayPoint> = [
	{
		get x() {
			shortened.length = 1;
			return 2;
		},
		y: 3,
	},
	{ x: 7, y: 11 },
];
array_reset();
let shortenedFailed = false;
try {
	array_sum(shortened);
} catch (error) {
	shortenedFailed = error instanceof TypeError;
}
check(shortenedFailed && array_calls() === 0, "changed array length rejects before C");

let freshReads = 0;
const fresh: Array<ArrayPoint> = [];
Object.defineProperty(fresh, "0", {
	get() {
		freshReads++;
		return {
			get x() {
				return Array.from({ length: 40 }, () => ({ value: 2 }))[0]!.value;
			},
			y: 3,
		};
	},
});
Object.defineProperty(fresh, "1", {
	get() {
		freshReads++;
		return { x: 7, y: 11 };
	},
});
check(
	array_sum(fresh) === 23 && freshReads === 2,
	"allocating getters retain fresh records",
);
check(
	array_sum([
		{ x: 2, y: 3 },
		{ x: 7, y: 11 },
	]) === 23,
	"ordinary records keep the bulk path",
);
console.log("array conversion order passed");
