// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	engine: { eval: true, realms: true },

	ffi: { worker: { contract: "worker.ffi.ts" } },
};
