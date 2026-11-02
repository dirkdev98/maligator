import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["input.h"],
	find: [{ includeDirs: ["."], sources: ["input.c"] }],
	functions: {
		input_length: { async: "input_length_async" },
		input_count: { params: { text: { string: { length: "length" } } } },
		input_alias: { returns: { string: true } },
		input_mutate: { params: { text: { string: true } } },
		input_callback: { params: { callback: { callback: { data: "data" } } } },
	},
} satisfies MaligatorLibraryContract;
