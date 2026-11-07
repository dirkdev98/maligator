import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["styles.h"],
	find: [{ includeDirs: ["."], sources: ["styles.c"] }],
	types: { Style: { handle: { destroy: "style_destroy" } } },
	functions: { style_shared: { returns: { borrowed: true } } },
} satisfies MaligatorLibraryContract;
