import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	// Apple's regex.h delegates its declarations to this sibling header.
	headers: ["state.h", "regex.h", ...(process.platform === "darwin" ? ["_regex.h"] : [])],
	find: [{ includeDirs: ["include"], sources: ["state.c"] }],
	types: {
		CallerState: { handle: { storage: "caller" } },
		CopiedState: { handle: {} },
		regex_t: { handle: { storage: "caller" } },
	},
	functions: {
		caller_state_same: { returns: { borrowed: true } },
		caller_state_visit: { params: { visit: { callback: { data: "data" } } } },
		regexec: { params: { "3": { constant: "0" }, "4": { constant: "nullptr" } } },
	},
} satisfies MaligatorLibraryContract;
