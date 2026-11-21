import { readFileSync } from "node:fs";

const fs = process.getBuiltinModule(process.env.MAL_TEST_FS_BUILTIN);
console.log(fs.readFileSync === readFileSync, typeof fs.createReadStream);
