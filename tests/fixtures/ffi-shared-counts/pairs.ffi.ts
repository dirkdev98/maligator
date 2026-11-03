import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["pairs.h"],
	find: [{ includeDirs: ["."], sources: ["pairs.c"] }],
	functions: {
		pair_dot: {
			params: {
				left: { array: { length: "count" }, nullable: true },
				right: { array: { length: "count" }, nullable: true },
			},
			async: "dotAsync",
		},
		pair_bytes: {
			params: {
				left: { bytes: { length: "count" }, nullable: true },
				right: { bytes: { length: "count" }, nullable: true },
				visit: { nullable: true, callback: { data: "data" } },
			},
			async: "bytesAsync",
		},
		pair_mixed: {
			params: {
				values: { array: { length: "count" } },
				bytes: { bytes: { length: "count" } },
			},
			async: "mixedAsync",
		},
		pair_reversed: {
			params: {
				values: { array: { length: "count" } },
				bytes: { bytes: { length: "count" } },
			},
			async: "reversedAsync",
		},
		pair_text: {
			params: {
				text: { string: { length: "count" } },
				bytes: { bytes: { length: "count" } },
			},
			async: "textAsync",
		},
	},
} satisfies MaligatorLibraryContract;
