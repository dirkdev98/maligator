import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";
// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["owner.h"],
	find: [{ includeDirs: ["."], sources: ["owner.c"] }],
	types: {
		OwnerBase: { handle: {} },
		OwnerResult: {
			handle: { destroy: "owner_result_destroy", collect: true },
			fields: {
				first: { handle: { lifetime: "owner" } },
				second: { handle: { lifetime: "owner" } },
				empty: { handle: { lifetime: "owner" } },
				library: { handle: { lifetime: "library" } },
				nodes: { handle: { lifetime: "owner" } },
			},
		},
		OwnerChild: {
			handle: { destroy: "owner_child_free", collect: true, views: ["OwnerBase"] },
			fields: { next: { handle: { lifetime: "owner" } } },
		},
		OwnerLeaf: { handle: {}, fields: { next: { handle: { lifetime: "owner" } } } },
	},
	functions: {
		owner_library_owned: { async: "libraryOwnedAsync" },
		owner_library_callback: {
			params: { callback: { callback: { data: "data" } } },
			async: "libraryCallbackAsync",
		},
		owner_close_child: {
			params: { done: { callback: { data: "data", closes: "child" } } },
			async: "closeChildAsync",
		},
		owner_result_new: { async: "newResultAsync" },
		owner_result_destroy: { async: "destroyResultAsync" },
		owner_child_free: { async: "destroyChildAsync" },
		owner_child_alias: { returns: { borrowed: true } },
		owner_child_wait: { async: "waitChildAsync" },
		owner_leaf_wait: { async: "waitLeafAsync" },
		owner_leaf_alias: { returns: { borrowed: true } },
		owner_leaf_visit: { params: { callback: { callback: { data: "data" } } } },
		owner_leaf_results: {
			params: { callback: { callback: { data: "data", returns: { lifetime: "call" } } } },
		},
		owner_result_wait: { async: "waitResultAsync" },
		owner_result_base: { returns: { borrowed: true } },
		owner_result_last_base: { returns: { borrowed: true } },
		owner_unreadable_base: { returns: { borrowed: true } },
		owner_child_from_base: { returns: { borrowed: true } },
		owner_lend_child: { params: { callback: { callback: { data: "data" } } } },
		owner_lend_result: { params: { callback: { callback: { data: "data" } } } },
		owner_visit_result: {
			params: { callback: { callback: { data: "data", returns: { lifetime: "call" } } } },
		},
		owner_watch_child: {
			params: {
				callback: {
					nullable: true,
					callback: { data: "data", release: "release", queued: "wait" },
				},
			},
			async: "watchChildAsync",
		},
		owner_replace_child: {
			params: {
				callback: {
					nullable: true,
					callback: { data: "data", replaced: true, queued: "wait" },
				},
			},
			async: "replaceChildAsync",
		},
		owner_child_visit: { params: { callback: { callback: { data: "data" } } } },
		owner_result_callback: {
			params: { callback: { callback: { data: "data" } } },
			async: "resultCallbackAsync",
		},
		owner_keep_child: {
			params: {
				callback: {
					callback: {
						data: "data",
						release: "release",
						queued: "wait",
						returns: { lifetime: "registration" },
					},
				},
			},
			async: "keepChildAsync",
		},
	},
} satisfies MaligatorLibraryContract;
