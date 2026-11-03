import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";
// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["resource.h"],
	find: [{ includeDirs: ["."], sources: ["resource.c"] }],
	types: {
		TxBase: { handle: {} },
		TxResource: { handle: { destroy: "tx_destroy", collect: false, views: ["TxBase"] } },
		TxManaged: {
			handle: { storage: "caller" },
			fields: { data: { bytes: { length: "length", writable: false } } },
		},
	},
	functions: {
		tx_invalid: { params: { out: { out: true } }, async: "invalidAsync" },
		tx_borrow: { returns: { borrowed: true } },
		tx_pair: {
			params: {
				other: { out: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "pairAsync",
		},
		tx_existing: {
			params: {
				other: { out: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "existingAsync",
		},
		tx_borrowed_result: {
			returns: { borrowed: true },
			params: {
				owned: { out: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "borrowedResultAsync",
		},
		tx_arm: { params: { callback: { callback: {} }, other: { out: true } } },
	},
} satisfies MaligatorLibraryContract;
