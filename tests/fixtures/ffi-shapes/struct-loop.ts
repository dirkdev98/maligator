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
console.log("ffi struct recurrence passed");
