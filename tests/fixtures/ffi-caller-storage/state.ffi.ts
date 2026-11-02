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
		VariableState: { handle: { storage: "caller", trailing: "tail" } },
		WideState: { handle: { storage: "caller", trailing: "tail" } },
	},
	functions: {
		caller_state_same: { returns: { borrowed: true } },
		variable_state_same: { returns: { borrowed: true } },
		variable_state_sum: { async: "variableStateSumAsync" },
		variable_state_visit: {
			async: "variableStateVisitAsync",
			params: { callback: { callback: { data: "data" } } },
		},
		caller_state_visit: { params: { visit: { callback: { data: "data" } } } },
		caller_state_listen: {
			params: { listener: { callback: { data: "data", replaced: true, queued: true } } },
		},
		regexec: { params: { "3": { constant: "0" }, "4": { constant: "nullptr" } } },
	},
} satisfies MaligatorLibraryContract;
