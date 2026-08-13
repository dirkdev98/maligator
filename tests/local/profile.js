let checksum = 0;
for (let outer = 0; outer < 40; outer++) {
	for (let index = 0; index < 1_000_000; index++) {
		checksum = (checksum + ((index ^ outer) & 255)) | 0;
	}
}
console.log(checksum);
