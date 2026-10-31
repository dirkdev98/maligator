/* oxlint-disable no-console -- The fixture reports its results on standard output. */
import {
	SHAPES_BIG,
	SHAPES_BOTH,
	SHAPES_ORIGIN,
	SHAPES_SCALE,
	SHAPES_VERSION,
	shapes_add,
	shapes_area,
	shapes_bitmap_fill,
	shapes_bitmap_free,
	shapes_bitmap_new,
	shapes_bitmap_shared,
	shapes_bitmap_sum,
	shapes_bitmaps_live,
	shapes_canvas_open,
	shapes_canvas_title,
	shapes_canvases_open,
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

{
	using canvas = shapes_canvas_open("Sketch");
	console.log(
		`canvas ${shapes_canvas_title(canvas)} ${shapes_canvas_title(null)} ${Object.prototype.toString.call(canvas)} open ${shapes_canvases_open()}`,
	);
}
console.log(`canvases after using ${shapes_canvases_open()}`);

const bitmap = shapes_bitmap_new(3, 2);
shapes_bitmap_fill(bitmap, 4);
console.log(
	`bitmap ${bitmap.width}x${bitmap.height} sum ${shapes_bitmap_sum(bitmap)} live ${shapes_bitmaps_live()}`,
);
shapes_bitmap_free(bitmap);
console.log(`bitmaps after free ${shapes_bitmaps_live()}`);
const shared = shapes_bitmap_shared();
shared[Symbol.dispose]();
console.log(`shared after dispose ${shapes_bitmap_sum(shapes_bitmap_shared())}`);

const rejected = [
	() => shapes_bitmap_sum(bitmap),
	() => shapes_canvas_title({} as unknown as ReturnType<typeof shapes_canvas_open>),
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
