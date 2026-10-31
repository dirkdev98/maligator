// oxlint-disable-next-line import/no-default-export -- contract fixture
export default {
	headers: ["shapes.h"],
	find: [{ sources: ["src/shapes.c"], includeDirs: ["include"] }],
};
