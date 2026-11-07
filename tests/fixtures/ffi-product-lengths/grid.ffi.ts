import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["grid.h"],
	find: [{ includeDirs: ["."], sources: ["grid.c"] }],
	functions: {
		fill_pixels: {
			params: { pixels: { bytes: { length: "width * height * 4" } } },
			async: "fillPixelsAsync",
		},
		sum_grid: {
			params: { values: { array: { length: "rows * cols" } } },
			async: "sumGridAsync",
		},
	},
} satisfies MaligatorLibraryContract;
