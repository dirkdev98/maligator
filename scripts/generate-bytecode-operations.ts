import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { generateBytecodeOperationInclude } from "../src/compiler/target/bytecode-operation-spec.ts";

writeFileSync(
	path.resolve("runtime/src/generated/bytecode_operations.inc"),
	generateBytecodeOperationInclude(),
);
