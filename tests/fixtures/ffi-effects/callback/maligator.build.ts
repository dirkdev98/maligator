// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",

	ffi: { callbacks: { contract: "callback.ffi.ts" } },
};
