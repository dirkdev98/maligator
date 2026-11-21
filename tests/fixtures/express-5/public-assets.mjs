import { embedDirectory } from "maligator:assets";

// Express serves a directory path; dotfiles stay so its own dotfile policy is exercised.
export const publicDirectory = embedDirectory("./public", { dot: true }).materialize();
