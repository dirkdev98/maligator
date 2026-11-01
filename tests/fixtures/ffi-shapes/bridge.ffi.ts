// oxlint-disable-next-line import/no-default-export -- contract fixture
export default {
	headers: ["bridge.h"],
	find: [{ sources: ["src/bridge.c"], includeDirs: ["include"] }],
	functions: {
		bridge_checksum: { params: { data: { bytes: { length: "size" } } } },
	},
};
