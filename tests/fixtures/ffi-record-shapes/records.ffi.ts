import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["records.h"],
	find: [{ includeDirs: ["."], sources: ["records.c"] }],
	types: { ShapeState: { handle: { storage: "caller" } } },
	functions: {
		shapes_copy: { async: "shapes_copy_async" },
		shapes_update: { params: { value: { inout: true } } },
		shapes_visit: { params: { visit: { callback: {} } } },
		shapes_total: { params: { values: { array: { length: "count" } } } },
	},
} satisfies MaligatorLibraryContract;
