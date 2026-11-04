import { readFileSync } from "node:fs";

const source = readFileSync(process.env.MAL_TEST_TEXT_FILE, "utf8");
const parsed = JSON.parse(source);
console.log(source.length, parsed.text.length, parsed.text.slice(-3), parsed.count);
