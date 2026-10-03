import "./pending-forever.mjs";
import "./rejecting-sibling.mjs";
throw new Error("parent body must not execute");
