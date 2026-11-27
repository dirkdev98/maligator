// Without "use strict" this file is sloppy, so the build links the complete
// process implementation although only process.env is read.
const home = process.env.HOME;
module.exports = home;
console.log(typeof home);
