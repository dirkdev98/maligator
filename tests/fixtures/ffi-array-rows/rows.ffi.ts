import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["rows.h"],
	find: [{ includeDirs: ["."], sources: ["rows.c"] }],
	types: {
		RowToken: { handle: { destroy: "row_token_destroy" } },
		Choice: { shape: { member: "integer" } },
		TaggedCell: { shape: { tag: "kind", cases: { "1": ["payload.integer"] } } },
	},
	functions: {
		rows_notify: {
			params: {
				callback: {
					callback: {
						data: "data",
						release: "release",
						queued: true,
						params: {
							"1": { array: { length: "2" }, nullable: true },
							"3": { array: { length: "4" }, nullable: true },
						},
					},
				},
			},
			async: "notifyAsync",
		},
		rows_fill_visit: {
			params: {
				values: { out: true, array: { length: "written", capacity: "capacity" } },
				callback: { callback: { data: "data" } },
			},
			async: "fillVisitAsync",
		},
		rows_fill: {
			params: {
				values: { out: true, array: { length: "written", capacity: "capacity" } },
			},
			async: "fillAsync",
		},
		rows_full: {
			params: {
				values: { out: true, array: { length: "capacity", capacity: "capacity" } },
			},
			async: "fullAsync",
		},
		rows_inout: {
			params: { values: { inout: true, array: { length: "count" } } },
			async: "inoutAsync",
		},
		rows_bad_count: {
			params: {
				values: { out: true, array: { length: "written", capacity: "capacity" } },
			},
			async: "badCountAsync",
		},
		cells_inout: {
			params: { values: { inout: true, array: { length: "count" } } },
			async: "cellsInoutAsync",
		},
		cells_fill: {
			params: {
				values: { out: true, array: { length: "written", capacity: "capacity" } },
			},
			async: "fillCellsAsync",
		},
		rows_created: {
			params: { values: { out: true, array: { length: "written" }, free: "rows_free" } },
			async: "createdAsync",
		},
		ints_fill: {
			params: {
				values: { out: true, array: { length: "written", capacity: "capacity" } },
			},
			async: "fillIntsAsync",
		},
		rows_sum: {
			params: { values: { array: { length: "count" }, nullable: true } },
			async: "sumAsync",
		},
		rows_bump: { params: { values: { array: { length: "count" } } }, async: "bumpAsync" },
		grids_sum: {
			params: { values: { array: { length: "count" } } },
			async: "gridsAsync",
		},
		cells_sum: {
			params: { values: { array: { length: "count" } } },
			async: "cellsAsync",
		},
		choices_sum: {
			params: { values: { array: { length: "count" }, shape: { member: "samples" } } },
			async: "choicesAsync",
		},
		tokens_sum: {
			params: { values: { array: { length: "count" } } },
			async: "tokensAsync",
		},
		rows_make: {
			returns: { array: { length: "count" }, free: "rows_free" },
			async: "makeRowsAsync",
		},
		cells_make: {
			returns: { array: { length: "count" }, free: "rows_free" },
			async: "makeCellsAsync",
		},
		tags_make: {
			returns: { array: { length: "count" }, free: "rows_free" },
			async: "makeTagsAsync",
		},
		rows_visit: {
			params: {
				values: { array: { length: "count" } },
				callback: {
					callback: { data: "data", params: { "1": { array: { length: "2" } } } },
				},
			},
			async: "visitAsync",
		},
	},
} satisfies MaligatorLibraryContract;
