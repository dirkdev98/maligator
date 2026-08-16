import { writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	generatePrimordialRegistryInclude,
	validateBuiltinRegistry,
} from "../src/builtin-registry.ts";

validateBuiltinRegistry();
writeFileSync(
	path.resolve("runtime/src/generated/primordial_registry.inc"),
	generatePrimordialRegistryInclude(),
);
