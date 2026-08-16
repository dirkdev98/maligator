import { basename } from "node:path";

let checksum = 0;
for (let index = 0; index < 2_000; index++) {
	const name = basename(`/tmp/maligator-${index}.js`);
	checksum += name.indexOf("-");
	if (/maligator/u.test(name)) checksum++;
}
console.log(checksum);
