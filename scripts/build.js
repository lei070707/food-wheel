"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const entry = path.join(root, "index.html");

if (!fs.existsSync(entry)) {
  console.error("Missing index.html at project root.");
  process.exit(1);
}

// dist 是纯静态发布目录，每次构建重新生成。
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(entry, path.join(dist, "index.html"));

console.log("Built dist/index.html");
