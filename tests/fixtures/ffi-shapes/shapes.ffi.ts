// oxlint-disable-next-line import/no-default-export -- contract fixture
export default {
	headers: ["shapes.h"],
	find: [{ sources: ["src/shapes.c"], includeDirs: ["include"] }],
	types: {
		ShapesCanvas: { handle: { destroy: "shapes_canvas_close", collect: true } },
		ShapesBitmap: { handle: { destroy: "shapes_bitmap_free" } },
		ShapesCall: { handle: {} },
	},
	functions: {
		shapes_bitmap_shared: { returns: { borrowed: true } },
		shapes_canvas_current: { returns: { borrowed: true } },
		shapes_get_first_canvas: { returns: { borrowed: true } },
		shapes_canvas_title: {
			params: { canvas: { nullable: true } },
			async: "shapes_canvas_title_async",
		},
		shapes_canvas_create: { params: { canvas: { out: true } } },
		shapes_parse: { params: { point: { out: true } }, async: "shapes_parse_async" },
		shapes_scale: { params: { point: { inout: true } } },
		shapes_bounds: {
			params: { points: { array: { length: "count" } }, box: { out: true } },
			async: "shapes_bounds_async",
		},
		shapes_checksum: {
			params: { data: { bytes: { length: "size" } } },
			async: "shapes_checksum_async",
		},
		shapes_watch: {
			params: {
				watcher: { callback: { data: "data", release: "release", queued: true } },
			},
		},
		shapes_pack: {
			params: {
				dest: { bytes: { length: "destLen" } },
				source: { bytes: { length: "sourceLen" } },
			},
		},
		shapes_set_ticker: {
			params: { ticker: { callback: { replaced: true, queued: true }, nullable: true } },
		},
		shapes_hold: {
			params: { data: { bytes: { length: "size" } } },
			async: "shapes_hold_async",
		},
		shapes_text_runes: { params: { text: { string: true } } },
		shapes_greeting: { returns: { string: true } },
		shapes_render: { returns: { bytes: { length: "size" }, free: "shapes_free" } },
		shapes_corners: { returns: { array: { length: "count" }, free: "shapes_free" } },
		shapes_describe: {
			returns: { string: true, free: "shapes_free" },
			async: "shapes_describe_async",
		},
		shapes_add: { async: "shapes_add_async" },
		shapes_each: {
			params: {
				points: { array: { length: "count" } },
				visit: { callback: { data: "data" } },
			},
		},
		shapes_integrate: { params: { f: { callback: { data: "data" } } } },
		shapes_fold: { params: { step: { callback: {} } } },
		shapes_join: {
			params: { parts: { array: { length: "count" } } },
			async: "shapes_join_async",
		},
		shapes_listen: {
			params: { listener: { callback: { data: "data", release: "release" } } },
		},
		shapes_canvas_visit: { params: { visit: { callback: { data: "data" } } } },
		shapes_canvas_lend: { params: { visit: { callback: { data: "data" } } } },
		shapes_set_error_handler: {
			params: { handler: { callback: { replaced: true }, nullable: true } },
		},
		shapes_canvas_on_resize: {
			params: { handler: { callback: { replaced: true }, nullable: true } },
		},
		shapes_register: {
			params: {
				fn: {
					callback: {
						data: "data",
						release: "destroy",
						lookup: { function: "shapes_call_data", param: "1" },
						params: { 3: { array: { length: "2" } } },
					},
				},
			},
		},
		shapes_canvas_on_draw: {
			params: { hook: { callback: { data: "data", replaced: true }, nullable: true } },
		},
		shapes_read: {
			params: {
				reader: {
					callback: {
						data: "data",
						params: { 3: { array: { length: "2" } }, 5: { bytes: { length: "4" } } },
					},
				},
			},
		},
		shapes_fill: {
			params: {
				data: { bytes: { length: "size" } },
				visit: { callback: { data: "ctx" } },
			},
		},
		shapes_mul: { params: { factor: { constant: "SHAPES_MAX_POINTS" } } },
		shapes_log: {
			variants: {
				shapes_log_count: { args: ["int"] },
				shapes_log_pair: { args: ["const char *", "double"] },
			},
		},
	},
};
