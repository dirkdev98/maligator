import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["requests.h"],
	find: [{ includeDirs: ["."], sources: ["requests.c"] }],
	functions: {
		request_device: {
			params: {
				info: {
					callback: {
						field: "callback",
						data: "userdata",
						once: true,
						constants: { mode: "REQUEST_DEFERRED" },
					},
				},
			},
		},
		request_value: { params: { done: { callback: { data: "userdata", once: true } } } },
		visit_values: {
			params: { visitor: { callback: { field: "visit", data: "userdata" } } },
		},
		request_threaded: {
			params: { done: { callback: { data: "userdata", once: true, queued: true } } },
		},
	},
} satisfies MaligatorLibraryContract;
