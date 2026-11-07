import * as imported from "./cjs-star-reexports/index.cjs";

const loaded = await import("./cjs-star-reexports/index.cjs");
console.log(imported.greet(), loaded.greet(), loaded.default.greet === loaded.greet);
