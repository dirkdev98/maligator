import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["ranges.h"],
	find: [{ includeDirs: ["."], sources: ["ranges.c"] }],
	functions: {
		wrap_position: { params: { text_end: { end: "text" } } },
		text_bytes: { params: { text_end: { end: "text" } }, async: "textBytesAsync" },
		nullable_bytes: { params: { text: { nullable: true }, text_end: { end: "text" } } },
	},
} satisfies MaligatorLibraryContract;
