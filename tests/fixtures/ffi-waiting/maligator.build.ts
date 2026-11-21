// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	engine: { eval: true, realms: true },

	ffi: { waiting: { contract: "waiting.ffi.ts", link: "shared" } },
};
