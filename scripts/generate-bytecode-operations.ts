import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { generateKnownBuiltinErrorInclude } from "../src/compiler/shared/known-builtin-errors.ts";
import { generateBytecodeOperationInclude } from "../src/compiler/target/bytecode-operation-spec.ts";

writeFileSync(
	path.resolve("runtime/src/generated/bytecode_operations.inc"),
	generateBytecodeOperationInclude(),
);
writeFileSync(
	path.resolve("runtime/src/generated/known_builtin_errors.inc"),
	generateKnownBuiltinErrorInclude(),
);
