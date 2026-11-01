import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["close.h"],
	find: [{ includeDirs: ["."], sources: ["close.c"] }],
	types: {
		CloseBase: { handle: {} },
		CloseState: {
			handle: { storage: "caller", views: ["CloseBase"] },
			fields: { bytes: { bytes: { length: "length" } } },
		},
	},
	functions: {
		close_now: { params: { done: { callback: { closes: "handle" } } } },
		close_later: { params: { done: { callback: { closes: "handle" } } } },
		close_foreign: { params: { done: { callback: { closes: "handle" } } } },
		close_after_vm: { params: { done: { callback: { closes: "handle" } } } },
		close_data: { params: { done: { callback: { closes: "handle", data: "data" } } } },
		close_visit: { params: { visit: { callback: { data: "data" } } } },
		close_lend: { params: { visit: { callback: { data: "data" } } } },
		close_reused_open: { returns: { fresh: true, borrowed: true } },
		close_reused_set: { params: { callback: { callback: { replaced: true } } } },
		close_reused_after_vm: { params: { done: { callback: { closes: "handle" } } } },
		close_with_error: {
			params: {
				before: { callback: { data: "data" } },
				done: { callback: { closes: "handle" } },
			},
		},
	},
} satisfies MaligatorLibraryContract;
