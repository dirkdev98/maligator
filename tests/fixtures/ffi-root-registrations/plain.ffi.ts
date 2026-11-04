import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";
// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["plain.h"],
	find: [{ includeDirs: ["."], sources: ["plain.c"] }],
	types: {
		PlainState: {
			handle: { storage: "caller", destroy: "plain_cleanup", collect: true },
		},
	},
	functions: {
		plain_init: {
			initializes: { param: "state" },
			returns: { string: { length: "length" } },
		},
	},
} satisfies MaligatorLibraryContract;
