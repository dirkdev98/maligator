import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["release.h"],
	find: [{ includeDirs: ["."], sources: ["release.c"] }],
	types: {
		BusyResource: {
			handle: { destroy: { function: "release_close", success: "RELEASE_OK" } },
		},
		AlwaysResource: { handle: { destroy: "release_always_close" } },
		BooleanResource: {
			handle: { destroy: { function: "release_boolean_close", success: "true" } },
		},
	},
	functions: {
		release_same: { returns: { borrowed: true } },
		release_close: { params: { resource: { nullable: true } } },
		release_watch: {
			params: { callback: { callback: { data: "data", release: "release" } } },
		},
	},
} satisfies MaligatorLibraryContract;
