import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";
// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["resource.h"],
	find: [{ includeDirs: ["."], sources: ["resource.c"] }],
	types: {
		TxTagged: {
			shape: {
				tag: "kind",
				cases: {
					"1": ["payload.fields"],
					"2": ["payload.policy"],
					"3": ["payload.number"],
					"4": [],
				},
			},
		},
		TxConstTagged: {
			shape: {
				tag: "kind",
				cases: {
					"1": ["payload.fields"],
					"2": ["payload.policy"],
					"3": ["payload.number"],
				},
			},
		},
		TxFreshTagged: {
			shape: { tag: "kind", cases: { "1": ["payload.fields"], "2": ["payload.number"] } },
		},
		TxPromotedTagged: {
			shape: { tag: "kind", cases: { "1": ["payload.fields"], "2": ["payload.number"] } },
		},
		TxPromotedFields: { fields: { first: { handle: { owned: true } } } },
		TxGrid: { fields: { tail: { handle: { owned: true } } } },
		TxPolicyFields: {
			fields: { first: { handle: { owned: true } }, second: { handle: { owned: true } } },
		},
		TxFreshRow: {
			fields: {
				owned: { handle: { owned: true } },
				fresh: { handle: { owned: true, fresh: true } },
			},
		},
		TxPool: { handle: { destroy: "tx_pool_destroy", collect: false } },
		TxChoice: { shape: { member: "fields" } },
		TxConstChoice: { shape: { member: "fields" } },
		TxFreshChoice: { shape: { member: "fields" } },
		TxFreshFields: {
			fields: {
				first: { handle: { owned: true, fresh: true } },
				second: { handle: { owned: true, fresh: true } },
			},
		},
		TxFields: {
			fields: {
				first: { handle: { owned: true } },
				second: { handle: { owned: true } },
				empty: { handle: { owned: true } },
			},
		},
		TxRecord: { fields: { third: { handle: { owned: true } } } },
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
		tx_pointer_existing: {
			params: {
				rows: {
					out: true,
					borrowed: true,
					array: { length: "written", capacity: "capacity" },
				},
				message: { out: true, string: { length: "length" } },
			},
			async: "pointerExistingAsync",
		},
		tx_pointer_buffer: {
			params: {
				rows: {
					out: true,
					borrowed: false,
					array: { length: "written", capacity: "capacity" },
				},
				prior: { nullable: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "pointerBufferAsync",
		},
		tx_pointer_borrowed: {
			params: {
				rows: {
					out: true,
					borrowed: true,
					array: { length: "written", capacity: "capacity" },
				},
				prior: { nullable: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "pointerBorrowedAsync",
		},
		tx_pointer_return: {
			returns: { borrowed: true, array: { length: "length" }, free: "tx_table_free" },
			async: "pointerReturnAsync",
		},
		tx_pointer_out: {
			params: {
				rows: {
					out: true,
					borrowed: true,
					array: { length: "length" },
					free: "tx_table_free",
				},
			},
			async: "pointerOutAsync",
		},
		tx_pointer_mixed: {
			params: {
				rows: {
					out: true,
					borrowed: true,
					array: { length: "written", capacity: "capacity" },
				},
				owned: { out: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "pointerMixedAsync",
		},
		tx_pointer_inout: {
			params: { rows: { inout: true, borrowed: false, array: { length: "length" } } },
			async: "pointerInoutAsync",
		},
		tx_pointer_inout_borrowed: {
			params: { rows: { inout: true, borrowed: true, array: { length: "length" } } },
			async: "pointerInoutBorrowedAsync",
		},
		tx_pointer_wait: {
			params: {
				rows: {
					out: true,
					borrowed: false,
					array: { length: "written", capacity: "capacity" },
				},
			},
			async: "pointerWaitAsync",
		},
		tx_caller_table: {
			params: {
				rows: { out: true, array: { length: "written", capacity: "capacity" } },
				alias: { out: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "callerTableAsync",
		},
		tx_caller_inout: {
			params: {
				rows: { inout: true, array: { length: "length" } },
				alias: { out: true },
			},
			async: "callerInoutAsync",
		},
		tx_caller_policy: {
			params: { rows: { out: true, array: { length: "written", capacity: "capacity" } } },
			async: "callerPolicyAsync",
		},
		tx_caller_tagged: {
			params: { rows: { out: true, array: { length: "written", capacity: "capacity" } } },
			async: "callerTaggedAsync",
		},
		tx_caller_grid: {
			params: { rows: { out: true, array: { length: "written", capacity: "capacity" } } },
			async: "callerGridAsync",
		},
		tx_caller_fresh: {
			returns: { borrowed: true },
			params: {
				rows: { out: true, array: { length: "written", capacity: "capacity" } },
				close: { callback: {} },
			},
			async: "callerFreshAsync",
		},
		tx_caller_arm: {
			params: {
				rows: { out: true, array: { length: "written", capacity: "capacity" } },
				callback: { callback: {} },
			},
		},
		tx_caller_wait: {
			params: { rows: { out: true, array: { length: "written", capacity: "capacity" } } },
			async: "callerWaitAsync",
		},
		tx_tagged_arm: { params: { callback: { callback: {} } } },
		tx_tagged: {
			params: {
				alias: { out: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "taggedAsync",
		},
		tx_tagged_grid: {
			params: {
				alias: { out: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "taggedGridAsync",
		},
		tx_tagged_visit: { params: { callback: { callback: { data: "data" } } } },
		tx_tagged_out: { params: { value: { out: true } } },
		tx_tagged_table: {
			returns: { array: { length: "length" }, free: "tx_table_free" },
			async: "taggedTableAsync",
		},
		tx_const_tagged: { async: "constTaggedAsync" },
		tx_tagged_fresh: {
			returns: { borrowed: true },
			params: { close: { callback: {} }, value: { out: true } },
			async: "taggedFreshAsync",
		},
		tx_inactive_fresh: {
			returns: { borrowed: true },
			params: { close: { callback: {} }, value: { out: true } },
		},
		tx_tagged_wait: { async: "taggedWaitAsync" },
		tx_const_tagged_wait: { async: "constTaggedWaitAsync" },
		tx_table_policy: {
			returns: { array: { length: "length" }, free: "tx_table_free" },
			async: "tablePolicyAsync",
		},
		tx_fresh_table: {
			returns: { borrowed: true },
			params: {
				close: { callback: {} },
				rows: { out: true, array: { length: "length" }, free: "tx_table_free" },
			},
			async: "freshTableAsync",
		},
		tx_table: {
			returns: { array: { length: "length" }, free: "tx_table_free" },
			params: {
				prior: { nullable: true },
				message: { out: true, string: { length: "text_length" } },
			},
			async: "tableAsync",
		},
		tx_table_out: {
			params: { rows: { out: true, array: { length: "length" }, free: "tx_table_free" } },
			async: "tableOutAsync",
		},
		tx_table_choice: {
			returns: { array: { length: "length" }, free: "tx_table_free" },
			async: "tableChoiceAsync",
		},
		tx_table_grid: {
			returns: { array: { length: "length" }, free: "tx_table_free" },
			async: "tableGridAsync",
		},
		tx_table_const: {
			returns: { array: { length: "length" }, free: "tx_table_free" },
			async: "tableConstAsync",
		},
		tx_static_table: {
			returns: { array: { length: "length" } },
			async: "staticTableAsync",
		},
		tx_table_arm: {
			returns: { array: { length: "length" }, free: "tx_table_free" },
			params: { callback: { callback: {} } },
		},
		tx_table_wait: {
			returns: { array: { length: "length" }, free: "tx_table_free" },
			async: "tableWaitAsync",
		},
		tx_policy_capacity: {
			returns: { array: { length: "length" } },
			params: { grid: { out: true } },
			async: "policyCapacityAsync",
		},
		tx_fresh_capacity: {
			returns: { array: { length: "length" } },
			params: { close: { callback: {} }, grid: { out: true } },
			async: "freshCapacityAsync",
		},
		tx_policy_wait: { async: "policyWaitAsync" },
		tx_grid: {
			params: {
				alias: { out: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "gridAsync",
		},
		tx_grid_arm: { params: { callback: { callback: {} } } },
		tx_grid_out: { params: { rows: { out: true } } },
		tx_grid_visit: { params: { callback: { callback: { data: "data" } } } },
		tx_grid_wait: { async: "gridWaitAsync" },
		tx_policy_grid: {
			params: { message: { out: true, string: { length: "length" } } },
			async: "policyGridAsync",
		},
		tx_fresh_grid: {
			returns: { borrowed: true },
			params: {
				close: { callback: {} },
				grid: { out: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "freshGridAsync",
		},
		tx_pool_create: { returns: { fresh: true } },
		tx_pool_peek: { returns: { borrowed: true } },
		tx_pool_reentry: {
			params: { text: { out: true, string: true, free: "tx_text_free" } },
		},
		tx_pool_keep: {
			params: {
				callback: {
					callback: {
						data: "data",
						release: "release",
						returns: { lifetime: "registration" },
					},
				},
			},
		},
		tx_pool_drop: { async: "poolDropAsync" },
		tx_pool_watch: {
			params: { callback: { callback: { owner: "value", replaced: true } } },
		},
		tx_native_keep: {
			params: {
				callback: {
					callback: {
						data: "data",
						release: "release",
						returns: { lifetime: "registration" },
					},
				},
			},
		},
		tx_native_drop: { async: "nativeDropAsync" },
		tx_native_wait: { params: { alias: { out: true } }, async: "nativeWaitAsync" },
		tx_special_borrowed_inout: {
			params: {
				value: { inout: true, borrowed: true, nullable: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "specialBorrowedInoutAsync",
		},
		tx_special_borrowed_out: {
			returns: { string: true, free: "tx_text_free" },
			params: {
				out: { out: true, borrowed: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "specialBorrowedOutAsync",
		},
		tx_base_visit: { params: { callback: { callback: { data: "data" } } } },
		tx_base_special: {
			returns: { borrowed: true },
			params: {
				owned: { out: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "baseSpecialAsync",
		},
		tx_special_borrowed_pair: {
			returns: { borrowed: true },
			params: {
				owned: { out: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "specialBorrowedPairAsync",
		},
		tx_special_borrowed_release: {
			returns: { borrowed: true },
			params: {
				text: { out: true, string: true, free: "tx_text_free" },
				message: { out: true, string: { length: "length" } },
			},
			async: "specialBorrowedReleaseAsync",
		},
		tx_special_borrowed: {
			returns: { borrowed: true },
			params: { message: { out: true, string: { length: "length" } } },
			async: "specialBorrowedAsync",
		},
		tx_choice_out: { params: { value: { out: true } } },
		tx_choice: {
			params: {
				other: { out: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "choiceAsync",
		},
		tx_choice_release: {
			params: {
				text: { out: true, string: true, free: "tx_text_free" },
				message: { out: true, string: { length: "length" } },
			},
			async: "choiceReleaseAsync",
		},
		tx_choice_visit: { params: { callback: { callback: { data: "data" } } } },
		tx_choice_wait: { async: "choiceWaitAsync" },
		tx_destroy: { async: "destroyResourceAsync" },
		tx_record: {
			params: { message: { out: true, string: { length: "length" } } },
			async: "recordAsync",
		},
		tx_record_existing: {
			params: {
				other: { out: true },
				message: { out: true, string: { length: "length" } },
			},
			async: "recordExistingAsync",
		},
		tx_record_release: {
			params: {
				text: { out: true, string: true, free: "tx_text_free" },
				message: { out: true, string: { length: "length" } },
			},
			async: "recordReleaseAsync",
		},
		tx_record_visit: { params: { callback: { callback: { data: "data" } } } },
		tx_record_wait: { async: "recordWaitAsync" },
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
