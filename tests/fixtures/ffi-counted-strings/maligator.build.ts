// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	engine: { eval: false, realms: false },

	ffi: { text: { contract: "text.ffi.ts" } },
};
