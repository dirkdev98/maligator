import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["fields.h"],
	find: [{ includeDirs: ["."], sources: ["fields.c"] }],
	types: { FlagState: { handle: { storage: "caller" } } },
	functions: {
		fields_copy: { async: "fields_copy_async" },
		fields_visit: { params: { callback: { callback: {} } } },
		fields_advance: { async: "fields_advance_async" },
		fields_advance_many: {
			async: "fields_advance_many_async",
			params: { states: { array: { length: "count" } } },
		},
		fields_observe: { params: { callback: { callback: {} } } },
	},
} satisfies MaligatorLibraryContract;
