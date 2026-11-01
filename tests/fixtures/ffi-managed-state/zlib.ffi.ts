import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["zlib.h"],
	find: [{ libraries: ["z"] }],
	types: {
		z_stream: {
			handle: { storage: "caller" },
			fields: {
				next_in: { bytes: { length: "avail_in", writable: false } },
				next_out: { bytes: { length: "avail_out", writable: true } },
			},
		},
	},
	functions: {
		deflateInit_: {
			params: {
				version: { constant: "ZLIB_VERSION" },
				stream_size: { sizeof: "z_stream" },
			},
		},
		inflateInit_: {
			params: {
				version: { constant: "ZLIB_VERSION" },
				stream_size: { sizeof: "z_stream" },
			},
		},
	},
} satisfies MaligatorLibraryContract;
