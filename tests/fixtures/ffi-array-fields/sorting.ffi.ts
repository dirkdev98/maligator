import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["sorting.h"],
	find: [{ includeDirs: ["."], sources: ["sorting.c"] }],
	types: {
		SortSpecs: {
			handle: {},
			fields: {
				specs: { array: { length: "count" } },
				order: { array: { length: "order_count" } },
				count: { value: true },
				weight: { value: true },
			},
		},
	},
	functions: {
		sort_specs: { returns: { borrowed: true } },
		empty_specs: { returns: { borrowed: true } },
	},
} satisfies MaligatorLibraryContract;
