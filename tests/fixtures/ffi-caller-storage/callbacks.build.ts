// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	engine: { eval: true, realms: true },
	surface: { node: true, webPlatform: true },
	ffi: { state: { contract: "state.ffi.ts" } },
};
