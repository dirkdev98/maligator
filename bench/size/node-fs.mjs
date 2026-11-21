import { readFileSync } from "node:fs";

process.stdout.write(readFileSync("bench/size/hello.txt", "utf8"));
