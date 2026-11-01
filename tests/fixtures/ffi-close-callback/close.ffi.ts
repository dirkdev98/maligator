import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["close.h"],
	find: [{ includeDirs: ["."], sources: ["close.c"] }],
	types: {
		CloseBase: { handle: {} },
		CloseState: {
			handle: { storage: "caller", views: ["CloseBase"] },
			fields: {
				bytes: { bytes: { length: "length" } },
				label: { string: { length: "label_length" } },
			},
		},
	},
	functions: {
		close_view_set: { params: { callback: { callback: { replaced: true } } } },
		close_block: { async: "close_block_async" },
		close_and_listen: {
			async: "close_and_listen_async",
			params: {
				done: { callback: { closes: "handle" } },
				listener: { callback: { replaced: true, queued: "wait" } },
			},
		},
		close_now: {
			async: "close_now_async",
			params: { done: { callback: { closes: "handle" } } },
		},
		close_later: {
			async: "close_later_async",
			params: { done: { callback: { closes: "handle" } } },
		},
		close_foreign: { params: { done: { callback: { closes: "handle" } } } },
		close_after_vm: { params: { done: { callback: { closes: "handle" } } } },
		close_worker_after_vm: {
			async: "close_worker_after_vm_async",
			params: { done: { callback: { closes: "handle" } } },
		},
		close_data: {
			async: "close_data_async",
			params: { done: { callback: { closes: "handle", data: "data" } } },
		},
		close_visit: { params: { visit: { callback: { data: "data" } } } },
		close_lend: { params: { visit: { callback: { data: "data" } } } },
		close_reused_open: { returns: { fresh: true, borrowed: true } },
		close_reused_set: {
			async: "close_reused_set_async",
			params: { callback: { callback: { replaced: true } } },
		},
		close_reused_after_vm: { params: { done: { callback: { closes: "handle" } } } },
		close_with_error: {
			params: {
				before: { callback: { data: "data" } },
				done: { callback: { closes: "handle" } },
			},
		},
	},
} satisfies MaligatorLibraryContract;
