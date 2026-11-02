import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["fields.h"],
	find: [{ includeDirs: ["."], sources: ["fields.c"] }],
	types: { FlagState: { handle: { storage: "caller" } } },
	functions: {
		fields_copy: { async: "fields_copy_async" },
		fields_visit: { params: { callback: { callback: {} } } },
	},
} satisfies MaligatorLibraryContract;
