/* oxlint-disable no-console -- The fixture reports its results on standard output. */
import {
	SHAPES_BIG,
	SHAPES_BOTH,
	SHAPES_ORIGIN,
	SHAPES_SCALE,
	SHAPES_VERSION,
	shapes_add,
	shapes_area,
	shapes_contains,
	shapes_mode_name,
	shapes_sum3,
	shapes_total,
	shapes_twice,
} from "maligator:ffi/shapes";

const box = { min: { x: 0, y: 0 }, max: { x: 4, y: 3 } };
console.log(`add ${JSON.stringify(shapes_add({ x: 1, y: 2 }, { x: 3, y: 4.5 }))}`);
console.log(`area ${shapes_area(box)}`);
console.log(
	`contains ${shapes_contains(box, { x: 1, y: 1 })} ${shapes_contains(box, { x: 9, y: 1 })}`,
);
console.log(`mode ${shapes_mode_name(SHAPES_BOTH)} ${shapes_mode_name(7)}`);
console.log(`total ${shapes_total(9007199254740993n, 1n)}`);
console.log(`sum ${shapes_sum3(1, 2, 3)} twice ${shapes_twice(21)}`);
console.log(
	`constants ${SHAPES_VERSION} ${SHAPES_SCALE} ${SHAPES_BIG} ${JSON.stringify(SHAPES_ORIGIN)}`,
);

const rejected = [
	() => shapes_twice(1.5),
	() => shapes_twice("2" as unknown as number),
	() => shapes_total(1 as unknown as bigint, 1n),
	() => shapes_add({ x: 1 } as unknown as { x: number; y: number }, { x: 0, y: 0 }),
];
for (const call of rejected) {
	try {
		call();
		console.log("accepted");
	} catch (error) {
		console.log(`rejected ${(error as Error).name}: ${(error as Error).message}`);
	}
}
