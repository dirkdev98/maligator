import { embedDirectory, embedFile } from "maligator:assets";

// The product builder writes these files and aliases each specifier to its output.
export const compilerWire = embedFile("maligator-product:compiler-wire");
export const compilerProducerDigests = embedFile("maligator-product:compiler-producers");
export const mutableDevelopmentRunner = embedFile("maligator-product:mutable-runner");

/** What the CLI needs to build a native runtime outside a checkout. */
export const runtime = embedDirectory("../runtime", {
	include: [
		"dev_main.c",
		"fragment_main.c",
		"host_main.c",
		"test262_main.c",
		"src/**",
		"rust/Cargo.toml",
		"rust/Cargo.lock",
		"rust/rust-toolchain.toml",
		"rust/src/**",
		"rust/include/**",
		"rust/vendor/regress/**",
		"vendor/llhttp/include/**",
		"vendor/llhttp/src/**",
		"vendor/llhttp/LICENSE-MIT",
		"vendor/libuv/LICENSE",
		"vendor/node/LICENSE",
		"vendor/sqlite/**",
		"vendor/unicode/LICENSE.txt",
		"vendor/cldr/LICENSE",
	],
});

export const license = embedFile("../LICENSE");
export const thirdPartyNotices = embedFile("../THIRD_PARTY_NOTICES.md");
export const testRuntime = embedFile("./testing/runtime.mjs");
export const testHost = embedDirectory("./testing", {
	include: ["host-driver.mts", "host-protocol.mts"],
});
/** Source platform modules the compiler reads from disk. */
export const platformSources = embedDirectory(".", {
	include: ["assets/**", "http/**", "workers/**", "testing/node-test.ts"],
});
