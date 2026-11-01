import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["text.h"],
	find: [{ includeDirs: ["."], sources: ["text.c"] }],
	functions: {
		text_length: { params: { text: { string: { length: "length" } } } },
		text_nullable: { params: { text: { string: { length: "length" }, nullable: true } } },
		text_legacy: { params: { text: { nullable: true } } },
		text_narrow: { params: { text: { string: { length: "length" } } } },
		text_plain: {
			params: { text: { string: { length: "length" } } },
			async: "text_plain_async",
		},
		text_copy: {
			params: { text: { string: { length: "length" }, nullable: true } },
			returns: { string: { length: "written" }, free: "text_free" },
			async: "text_copy_async",
		},
		text_view: {
			params: { text: { string: { length: "length" }, nullable: true } },
			returns: { string: { length: "length" } },
			async: "text_view_async",
		},
		text_invalid: { returns: { string: { length: "length" } } },
		text_bad_count: {
			returns: { string: { length: "length" }, free: "text_free" },
			async: "text_bad_count_async",
		},
		text_callback: {
			params: { callback: { callback: { data: "data" } } },
			returns: { string: { length: "length" }, free: "text_free" },
		},
		text_counted_callback: {
			params: {
				callback: {
					callback: { data: "data", params: { "1": { string: { length: "2" } } } },
				},
			},
		},
	},
} satisfies MaligatorLibraryContract;
