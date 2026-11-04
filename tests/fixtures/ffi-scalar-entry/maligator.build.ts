// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	engine: { eval: false, realms: false },
	surface: { node: true, webPlatform: true },
	ffi: { scalar: { contract: "scalar.ffi.ts" } },
};
