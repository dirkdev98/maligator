/* oxlint-disable no-console -- The fixture reports successful native behavior. */
import { shapes_add } from "maligator:ffi/shapes";

type Point = { x: number; y: number };

function check(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

function advance(input: Point, count: number): Point {
	let position = input;
	const velocity = { x: 1, y: 0.5 };
	for (let index = 0; index < count; index++) position = shapes_add(position, velocity);
	return position;
}

function fields(input: Point, count: number): number {
	let position = input;
	const velocity = { x: 1, y: 0.5 };
	for (let index = 0; index < count; index++) position = shapes_add(position, velocity);
	return position.x + position.y;
}

function seeded(count: number, rounds: number): number {
	let sum = 0;
	for (let round = 0; round < rounds; round++) {
		let position = { x: 0, y: 0 };
		const velocity = { x: 1, y: 0.5 };
		for (let index = 0; index < count; index++) position = shapes_add(position, velocity);
		sum += position.x + position.y;
	}
	return sum;
}

for (const count of [0, 1, 20]) {
	const input = { x: 2, y: 4 };
	const result = advance(input, count);
	check(result.x === 2 + count && result.y === 4 + count * 0.5, "recurrence values");
	check((result === input) === (count === 0), "zero-iteration identity");
	check(input.x === 2 && input.y === 4, "input is unchanged");
}
check(seeded(5, 3) === 22.5 && seeded(0, 3) === 0, "nested seed values");

let getterReads = 0;
const allocating = {
	get x() {
		getterReads++;
		return Array.from({ length: 40 }, () => ({ value: 2 }))[0]!.value;
	},
	get y() {
		getterReads++;
		return Array.from({ length: 40 }, () => ({ value: 4 }))[0]!.value;
	},
};
check(fields(allocating, 0) === 6 && getterReads === 2, "zero-iteration getters");
check(fields(allocating, 4) === 12 && getterReads === 4, "allocating input getters");

const reads: Array<string> = [];
const proxy = new Proxy(
	{ x: 2, y: 4 },
	{
		get(target, key, receiver): unknown {
			reads.push(String(key));
			return Reflect.get(target, key, receiver);
		},
	},
);
check(fields(proxy, 4) === 12 && reads.join(",") === "x,y", "proxy conversion");

let entered = false;
const reentrant = {
	get x() {
		if (!entered) {
			entered = true;
			check(advance({ x: 10, y: 20 }, 2).x === 12, "reentrant result");
		}
		return 2;
	},
	y: 4,
};
check(fields(reentrant, 4) === 12, "reentrant input getter");

let threw = false;
try {
	advance(
		{
			x: 2,
			get y(): number {
				throw new Error("conversion failed");
			},
		},
		1,
	);
} catch (error) {
	threw = error instanceof Error && error.message === "conversion failed";
}
check(threw, "throwing input getter");

function saved(input: Point, count: number): { previous: Array<Point>; position: Point } {
	let position = input;
	const previous: Array<Point> = [];
	const velocity = { x: 1, y: 0.5 };
	for (let index = 0; index < count; index++) {
		const prior = position;
		position = shapes_add(position, velocity);
		previous.push(prior);
	}
	return { previous, position };
}
const original = { x: 2, y: 4 };
const history = saved(original, 4);
check(
	history.previous[0] === original && history.position.x === 6,
	"saved input identity",
);
for (let index = 0; index < history.previous.length; index++) {
	const prior = history.previous[index]!;
	check(prior.x === 2 + index && prior.y === 4 + index * 0.5, "saved generation values");
	check(prior !== history.position, "saved generation identity");
}

function handled(input: Point): Point {
	let position = input;
	let calls = 0;
	const velocity = {
		x: 1,
		get y() {
			if (++calls === 2) throw new Error("second conversion failed");
			return 0.5;
		},
	};
	for (let index = 0; index < 4; index++) {
		try {
			position = shapes_add(position, velocity);
		} catch {
			return position;
		}
	}
	return position;
}
const retained = handled(original);
check(
	retained.x === 3 && retained.y === 4.5 && retained !== original,
	"handled conversion retains the prior result",
);

function conditional(input: Point, count: number): Point {
	let position = input;
	const a = { x: 1, y: 0.5 };
	const b = { x: 2, y: 1 };
	for (let index = 0; index < count; index++)
		if (index % 2) position = shapes_add(position, a);
		else position = shapes_add(position, b);
	return position;
}
const mixed = conditional(original, 10);
check(mixed.x === 17 && mixed.y === 11.5, "conditional producer values");

function skipped(input: Point, count: number, stride: number): Point {
	let position = input;
	const velocity = { x: 1, y: 0.5 };
	for (let index = 0; index < count; index++)
		if (stride > 0 && index % stride === 0) position = shapes_add(position, velocity);
	return position;
}
for (const count of [0, 1, 8])
	for (const stride of [0, 1, 2]) {
		let reads = 0;
		const input = {
			get x() {
				reads++;
				return 2;
			},
			get y() {
				reads++;
				return 4;
			},
		};
		const result = skipped(input, count, stride);
		const calls = stride === 0 ? 0 : Math.ceil(count / stride);
		check(
			reads === (calls === 0 ? 0 : 2),
			"skipped producers leave input getters untouched",
		);
		check((result === input) === (calls === 0), "zero-call input identity");
		if (calls > 0)
			check(
				result.x === 2 + calls && result.y === 4 + calls * 0.5,
				"skipped producer values",
			);
	}

function permuted(input: Point, count: number): number {
	let position = input,
		previous = input;
	const velocity = { x: 1, y: 0.5 };
	for (let index = 0; index < count; index++) {
		const next = shapes_add(position, velocity);
		position = previous;
		previous = next;
	}
	return position.x + position.y + previous.x + previous.y;
}
for (const count of [0, 1, 2, 8])
	check(
		permuted(original, count) === 12 + count * 1.5,
		"phi permutations preserve prior generations",
	);

function selectivelyObserved(
	input: Point,
	count: number,
	visit: (point: Point, index: number) => void,
): Point {
	let position = input;
	const velocity = {
		get x() {
			return Array.from({ length: 40 }, () => ({ value: 1 }))[0]!.value;
		},
		y: 0.5,
	};
	for (let index = 0; index < count; index++) {
		if (index % 3 === 0) visit(position, index);
		if (index % 2 === 0) position = shapes_add(position, velocity);
	}
	return position;
}
const selectedHistory: Array<{ point: Point; x: number; y: number }> = [];
const selected = selectivelyObserved({ x: 2, y: 4 }, 8, (point, index) => {
	point.x += 10;
	selectedHistory.push({ point, x: point.x, y: point.y });
	if (index === 3)
		check(advance({ x: 10, y: 20 }, 2).x === 12, "conditional producer reentry");
});
check(selected.x === 36 && selected.y === 6, "observed conditional producer values");
for (const saved of selectedHistory)
	check(
		saved.point.x === saved.x && saved.point.y === saved.y && saved.point !== selected,
		"conditional observations preserve heap generations",
	);

function observed(
	input: Point,
	count: number,
	stride: number,
	visit: (point: Point, index: number) => void,
): Point {
	let position = input;
	const velocity = { x: 1, y: 0.5 };
	for (let index = 0; index < count; index++) {
		if (index % stride === 0) {
			const alias = position;
			visit(alias, index);
		}
		position = shapes_add(position, velocity);
	}
	return position;
}

for (const [count, stride] of [
	[0, 1],
	[1, 1],
	[8, 1],
	[8, 2],
] as const) {
	const input = { x: 2, y: 4 };
	const prior: Array<{ point: Point; x: number; y: number }> = [];
	let visits = 0;
	const result = observed(input, count, stride, (point, index) => {
		visits++;
		const value = point.x + 10;
		Object.defineProperty(point, "x", {
			get() {
				return Array.from({ length: 40 }, () => ({ value }))[0]!.value;
			},
			configurable: true,
		});
		prior.push({ point, x: value, y: point.y });
		if (index === 2) check(advance({ x: 10, y: 20 }, 2).x === 12, "observed reentry");
	});
	check(visits === Math.ceil(count / stride), "conditional observer count");
	check(
		result.x === 2 + visits * 10 + count && result.y === 4 + count * 0.5,
		"observed recurrence values",
	);
	check((result === input) === (count === 0), "observed zero-iteration identity");
	for (const saved of prior) {
		check(
			saved.point.x === saved.x && saved.point.y === saved.y,
			"observed generation remains stable",
		);
		check(saved.point !== result, "observed generation identity");
	}
}
console.log("ffi struct recurrence passed");
