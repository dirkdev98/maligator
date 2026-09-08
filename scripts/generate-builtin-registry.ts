import { writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	generatePrimordialRegistryInclude,
	validateBuiltinRegistry,
} from "../src/compiler/shared/builtin-registry.ts";
import { generateLiteralPrototypeMethods } from "../src/compiler/shared/builtin-registry.ts";

validateBuiltinRegistry();
writeFileSync(
	path.resolve("runtime/src/generated/primordial_registry.inc"),
	generatePrimordialRegistryInclude(),
);

writeFileSync(
	path.resolve("runtime/src/generated/literal_prototype_methods.inc"),
	generateLiteralPrototypeMethods(),
);
