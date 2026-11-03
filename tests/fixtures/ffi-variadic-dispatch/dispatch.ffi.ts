import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";
// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["dispatch.h"],
	find: [{ includeDirs: ["."], sources: ["dispatch.c"] }],
	functions: {
		dispatch_apply: {
			dispatch: "invoke",
			params: { marker: { constant: "DISPATCH_MARKER" } },
			variants: {
				small: {
					args: ["int", "signed char", "unsigned short", "float"],
					params: { arg2: { constant: "DISPATCH_SMALL" } },
				},
				mixed: {
					args: ["int", "const char *", "double", "long long"],
					params: { arg2: { constant: "DISPATCH_MIXED" } },
				},
				array: {
					args: ["int", "const int *", "size_t"],
					params: {
						arg2: { constant: "DISPATCH_ARRAY" },
						arg3: { array: { length: "arg4" } },
					},
				},
				output: {
					args: ["int", "int *"],
					params: { arg2: { constant: "DISPATCH_OUT" }, arg3: { out: true } },
				},
				callback: {
					args: ["int", "int (*)(int, void *)", "void *"],
					params: {
						arg2: { constant: "DISPATCH_CALLBACK" },
						arg3: { callback: { data: "arg4" } },
					},
				},
			},
		},
		dispatch_empty: {
			dispatch: "invokeEmpty",
			variants: { noExtra: { args: [] }, oneExtra: { args: ["signed char"] } },
		},
	},
} satisfies MaligatorLibraryContract;
