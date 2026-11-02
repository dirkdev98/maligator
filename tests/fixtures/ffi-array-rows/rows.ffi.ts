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
