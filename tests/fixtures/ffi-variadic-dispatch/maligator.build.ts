// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	entry: "main.ts",
	engine: { eval: false, realms: false },
	ffi: { variadic_dispatch: { contract: "dispatch.ffi.ts" } },
};
