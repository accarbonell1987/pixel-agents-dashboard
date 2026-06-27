import { copyFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const src = join(root, "assets/tileset/Office Tileset/Office Tileset All 16x16.png");
const dest = join(root, "assets/office_tileset_16x16.png");

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`Tileset copied to ${dest}`);
