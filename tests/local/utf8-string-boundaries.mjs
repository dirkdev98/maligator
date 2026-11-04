import { Buffer } from "node:buffer";
import { StringDecoder } from "node:string_decoder";

const size = 64 * 1024 * 1024;
function check(condition) {
	if (!condition) throw new Error("UTF-8 output boundary mismatch");
}

const count = Math.floor((size * 2) / 3) + 1;
const multibyte = Buffer.alloc(count * 3, "€");
const stream = new StringDecoder();
check(stream.write(multibyte).length === count);
check(stream.end() === "");
check(new TextDecoder().decode(multibyte).length === count);
check((await new Response(multibyte).text()).length === count);

const withBom = Buffer.alloc(size + 3, "a");
withBom[0] = 0xef;
withBom[1] = 0xbb;
withBom[2] = 0xbf;
check(new TextDecoder().decode(withBom).length === size);
check((await new Response(withBom).text()).length === size);

check(new TextDecoder("utf-8", { ignoreBOM: true }).decode(withBom).length === size + 1);
check(new StringDecoder().end(withBom).length === size + 1);
console.log("utf8-string-boundaries PASS");
