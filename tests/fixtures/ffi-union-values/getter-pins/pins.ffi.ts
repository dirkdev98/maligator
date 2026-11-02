import type { MaligatorLibraryContract } from "../../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["pins.h"],
	find: [{ includeDirs: ["."], sources: ["pins.c"] }],
	types: {
		Owner: { handle: { destroy: "pins_free" } },
		Choice: { shape: { member: "point" } },
	},
	functions: { pins_array: { params: { input: { shape: { member: "items" } } } } },
} satisfies MaligatorLibraryContract;
