import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["waiting.h"],
	find: [{ includeDirs: ["."], libraryDirs: ["."], libraries: ["waiting"] }],
	functions: {
		waiting_set_integer: {
			params: {
				callback: { callback: { data: "data", release: "release", queued: "wait" } },
			},
		},
		waiting_set_record: {
			params: {
				callback: { callback: { data: "data", release: "release", queued: "wait" } },
			},
		},
		waiting_set_void: {
			params: {
				callback: { callback: { data: "data", release: "release", queued: "wait" } },
			},
		},
		waiting_set_keyed: {
			params: {
				callback: { callback: { replaced: true, queued: "wait" }, nullable: true },
			},
		},
		waiting_join: { async: "waiting_join_async" },
	},
} satisfies MaligatorLibraryContract;
