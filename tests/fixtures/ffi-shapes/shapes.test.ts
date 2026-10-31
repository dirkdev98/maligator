import {
	shapes_add,
	shapes_canvas_open,
	shapes_canvases_open,
} from "maligator:ffi/shapes";
import { describe, expect, test } from "maligator:test";

describe("shapes", () => {
	test("adds points", () => {
		expect(shapes_add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
	});

	test("closes a canvas when its scope ends", () => {
		{
			using canvas = shapes_canvas_open("Test");
			expect(canvas).not.toBeNull();
			expect(shapes_canvases_open()).toBe(1);
		}
		expect(shapes_canvases_open()).toBe(0);
	});
});
