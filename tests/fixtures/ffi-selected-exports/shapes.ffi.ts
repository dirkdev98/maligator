// oxlint-disable-next-line import/no-default-export -- library contract fixture
export default {
	headers: ["shapes.h"],
	find: [{ includeDirs: ["."], sources: ["empty.c"] }],
	types: {
		ShapeBase: { handle: {} },
		ShapeCircle: { handle: { views: ["ShapeBase"], destroy: "shape_circle_free" } },
		// Declared without a definition: only an unread family member links it.
		ShapeSquare: {
			handle: { views: ["ShapeBase"], destroy: "shape_square_free" },
			fields: { origin: { handle: { lifetime: "owner" } } },
		},
	},
	functions: {
		shape_watch: { params: { callback: { callback: { data: "data" } } } },
	},
};
