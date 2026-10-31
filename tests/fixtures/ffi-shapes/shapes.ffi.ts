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
		shapes_canvas_title: { params: { canvas: { nullable: true } } },
	},
};
