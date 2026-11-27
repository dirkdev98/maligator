"use strict";
// A strict file that only reads process.env links just the environment.
const home = process.env.HOME;
module.exports = home;
console.log(typeof home);
