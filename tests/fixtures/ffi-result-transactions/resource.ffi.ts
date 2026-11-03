import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";
// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["resource.h"],
	find: [{ includeDirs: ["."], sources: ["resource.c"] }],
	types: {
		TxSpecial: {
			handle: { destroy: "tx_special_destroy", collect: false, views: ["TxResource"] },
		},
		TxParent: {
			handle: { destroy: "tx_parent_destroy", collect: false },
			fields: {
				child: { handle: { lifetime: "owner" } },
				library: { handle: { lifetime: "library" } },
			},
		},
		TxBase: { handle: {} },
		TxResource: { handle: { destroy: "tx_destroy", collect: false, views: ["TxBase"] } },
		TxManaged: {
			handle: { storage: "caller" },
			fields: { data: { bytes: { length: "length", writable: false } } },
		},
	},
	functions: {
		tx_special_peek: { returns: { borrowed: true } },
		tx_special_existing: {
			params: {
				text: { out: true, string: true, free: "tx_text_free" },
				message: { out: true, string: { length: "length" } },
			},
		},
		tx_recycled: { returns: { fresh: true } },
		tx_reentry_recycled: {
			returns: { fresh: true },
			params: {
				text: { out: true, string: true, free: "tx_text_free" },
				message: { out: true, string: { length: "length" } },
			},
			async: "reentryRecycledAsync",
		},
		tx_reentry_existing: {
			params: {
				text: { out: true, string: true, free: "tx_text_free" },
				message: { out: true, string: { length: "length" } },
			},
			async: "reentryExistingAsync",
		},
		tx_reentry_before: {
			returns: { string: true, free: "tx_text_free" },
			params: {
				out: { out: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "reentryBeforeAsync",
		},
		tx_input: {
			params: { callback: { callback: { data: "data", release: "release" } } },
		},
		tx_peek: { returns: { borrowed: true } },
		tx_read: { async: "readAsync" },
		tx_watch: { params: { callback: { nullable: true, callback: { replaced: true } } } },
		tx_register: {
			params: {
				callback: {
					nullable: true,
					callback: { replaced: true, returns: { lifetime: "registration" } },
				},
			},
		},
		tx_reentry: {
			params: {
				text: { out: true, string: true, free: "tx_text_free" },
				message: { out: true, string: { length: "length" } },
			},
			async: "reentryAsync",
		},
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
