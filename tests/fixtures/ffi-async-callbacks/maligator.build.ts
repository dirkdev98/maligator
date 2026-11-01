// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	engine: { eval: true, realms: true },
	surface: { node: true, webPlatform: true },
	ffi: { callbacks: { contract: "async.ffi.ts" } },
};
