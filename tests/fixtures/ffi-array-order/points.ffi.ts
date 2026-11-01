// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["points.h"],
	find: [{ includeDirs: ["."], sources: ["points.c"] }],
	functions: { array_sum: { params: { points: { array: { length: "length" } } } } },
};
