import type { MaligatorLibraryContract } from "../../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["callback.h"],
	find: [{ includeDirs: ["."], sources: ["callback.c"] }],
	functions: { effects_scope: { params: { callback: { callback: { data: "data" } } } } },
} satisfies MaligatorLibraryContract;
