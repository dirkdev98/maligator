import { createReadStream } from "node:fs";

let contents = "";
for await (const chunk of createReadStream("bench/size/hello.txt", {
	encoding: "utf8",
})) {
	contents += chunk;
}
console.log(contents.trim());
