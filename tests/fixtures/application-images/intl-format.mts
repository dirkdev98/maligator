import process from "node:process";

process.stdout.write(new Intl.NumberFormat("en-US").format(1234));
