// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	engine: { eval: false, realms: false },

	ffi: { views: { contract: "views.ffi.ts" } },
};
