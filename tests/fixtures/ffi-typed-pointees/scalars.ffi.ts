import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["scalars.h"],
	find: [{ includeDirs: ["."], sources: ["scalars.c"] }],
	functions: {
		scalar_step: {
			dispatch: "scalarStep",
			variants: {
				scalar_step_double: {
					params: {
						type: { constant: "DATA_DOUBLE" },
						value: { pointee: "double", inout: true },
					},
				},
				scalar_step_int: {
					params: {
						type: { constant: "DATA_INT" },
						value: { pointee: "int", inout: true },
					},
				},
			},
		},
		scalar_clamp: {
			variants: {
				scalar_clamp_double: {
					params: {
						type: { constant: "DATA_DOUBLE" },
						value: { pointee: "double", inout: true },
						minimum: { pointee: "double", inout: true },
						maximum: { pointee: "double", inout: true },
					},
				},
			},
		},
	},
} satisfies MaligatorLibraryContract;
