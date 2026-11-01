import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["text.h"],
	find: [{ includeDirs: ["."], sources: ["text.c"] }],
	functions: {
		text_mixed_notify: {
			async: "text_mixed_notify_async",
			params: {
				callback: {
					callback: {
						data: "data",
						release: "release",
						queued: true,
						params: { "2": { string: { length: "3" } } },
					},
				},
			},
		},
		text_notify: {
			async: "text_notify_async",
			params: {
				callback: {
					callback: {
						data: "data",
						release: "release",
						queued: true,
						params: { "1": { string: { length: "2" } } },
					},
				},
			},
		},
		text_wait: {
			async: "text_wait_async",
			params: {
				callback: {
					callback: {
						data: "data",
						release: "release",
						queued: "wait",
						params: { "1": { string: { length: "2" } } },
					},
				},
			},
		},
		text_out: {
			async: "text_out_async",
			params: { text: { out: true, string: { length: "length" }, free: "text_free" } },
		},
		text_out_bad: {
			async: "text_out_bad_async",
			params: { text: { out: true, string: { length: "length" }, free: "text_free" } },
		},
		text_out_callback: {
			async: "text_out_callback_async",
			params: {
				callback: { callback: { data: "data" } },
				text: { out: true, string: { length: "length" }, free: "text_free" },
			},
		},
		text_advance: {
			async: "text_advance_async",
			params: { text: { inout: true, string: { length: "length" }, nullable: true } },
		},
		text_advance_first: {
			async: "text_advance_first_async",
			params: { text: { inout: true, string: { length: "length" }, nullable: true } },
		},
		text_inout_copy: {
			async: "text_inout_copy_async",
			params: {
				text: {
					inout: true,
					string: { length: "length" },
					nullable: true,
					free: "text_free",
				},
			},
		},
		text_inout_fixed: {
			async: "text_inout_fixed_async",
			params: { text: { inout: true, string: { length: "length" }, nullable: true } },
		},
		text_length: { params: { text: { string: { length: "length" } } } },
		text_nullable: { params: { text: { string: { length: "length" }, nullable: true } } },
		text_legacy: { params: { text: { nullable: true } } },
		text_many: { params: { texts: { array: { length: "count" } } } },
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
