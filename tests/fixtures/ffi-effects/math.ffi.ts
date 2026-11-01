import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["math.h"],
	find: [{ includeDirs: ["."], sources: ["math.c"] }],
	functions: {
		effects_touch: { params: { bytes: { bytes: { length: "length" } } } },
		effects_points: { params: { points: { array: { length: "count" } } } },
	},
} satisfies MaligatorLibraryContract;
