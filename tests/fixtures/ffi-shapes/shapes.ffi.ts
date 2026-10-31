// oxlint-disable-next-line import/no-default-export -- contract fixture
export default {
	headers: ["shapes.h"],
	find: [{ sources: ["src/shapes.c"], includeDirs: ["include"] }],
	types: {
		ShapesCanvas: { handle: { destroy: "shapes_canvas_close", collect: true } },
		ShapesBitmap: { handle: { destroy: "shapes_bitmap_free" } },
	},
	functions: {
		shapes_bitmap_shared: { returns: { borrowed: true } },
		shapes_canvas_current: { returns: { borrowed: true } },
		shapes_canvas_title: { params: { canvas: { nullable: true } } },
		shapes_canvas_create: { params: { canvas: { out: true } } },
		shapes_parse: { params: { point: { out: true } } },
		shapes_scale: { params: { point: { inout: true } } },
		shapes_bounds: {
			params: { points: { array: { length: "count" } }, box: { out: true } },
		},
		shapes_checksum: { params: { data: { bytes: { length: "size" } } } },
		shapes_render: { returns: { bytes: { length: "size" }, free: "shapes_free" } },
		shapes_corners: { returns: { array: { length: "count" }, free: "shapes_free" } },
		shapes_describe: { returns: { string: true, free: "shapes_free" } },
		shapes_each: {
			params: {
				points: { array: { length: "count" } },
				visit: { callback: { data: "data" } },
			},
		},
		shapes_integrate: { params: { f: { callback: { data: "data" } } } },
		shapes_join: { params: { parts: { array: { length: "count" } } } },
		shapes_log: {
			variants: {
				shapes_log_count: { args: ["int"] },
				shapes_log_pair: { args: ["const char *", "double"] },
			},
		},
	},
};
