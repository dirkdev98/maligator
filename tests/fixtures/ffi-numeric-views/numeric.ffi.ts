import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["numeric.h"],
	find: [{ includeDirs: ["."], sources: ["numeric.c"] }],
	functions: {
		numeric_independent: {
			params: {
				left: { array: { length: "left_count" } },
				right: { array: { length: "right_count" } },
			},
		},
		numeric_i8: { params: { values: { array: { length: "count" } } } },
		numeric_u8: { params: { values: { array: { length: "count" } } } },
		numeric_i16: { params: { values: { array: { length: "count" } } } },
		numeric_u16: {
			params: { values: { array: { length: "count" } } },
			async: "u16Async",
		},
		numeric_i32: { params: { values: { array: { length: "count" } } } },
		numeric_u32: { params: { values: { array: { length: "count" } } } },
		numeric_i64: {
			params: { values: { array: { length: "count" } } },
			async: "i64Async",
		},
		numeric_u64: { params: { values: { array: { length: "count" } } } },
		numeric_f32: { params: { values: { array: { length: "count" } } } },
		numeric_f64: {
			params: { values: { array: { length: "count" }, nullable: true } },
			async: "sumAsync",
		},
		numeric_dot: {
			params: {
				left: { array: { length: "count" } },
				right: { array: { length: "count" } },
			},
			async: "dotAsync",
		},
		numeric_visit: {
			params: {
				values: { array: { length: "count" } },
				visit: { callback: { data: "data" } },
			},
			async: "visitAsync",
		},
		numeric_mutable: { params: { values: { array: { length: "count" } } } },
		numeric_bool: { params: { values: { array: { length: "count" } } } },
	},
} satisfies MaligatorLibraryContract;
