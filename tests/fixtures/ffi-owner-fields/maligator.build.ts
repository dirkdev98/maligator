// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	entry: "main.ts",
	engine: { eval: true, realms: true, primordials: "mutable" },
	surface: { webPlatform: true, node: true },
	ffi: { owner_fields: { contract: "owner.ffi.ts" } },
};
