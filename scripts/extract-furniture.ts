/**
 * Furniture Extraction Script
 *
 * Reads the 32x32 Office Tileset, extracts non-empty cells as individual PNGs,
 * and generates a furniture-catalog.json for the server's loadFurnitureAssets().
 *
 * Multi-tile items are handled via the ANNOTATIONS table below.
 * Chair rotation groups are handled via CHAIR_GROUPS.
 * Unannotated non-empty cells default to 1×1.
 *
 * Usage:  npm run extract-furniture
 * Output: webview-ui/public/assets/furniture/  (PNGs + furniture-catalog.json)
 */

import * as fs from "fs";
import * as path from "path";
import { PNG } from "pngjs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const CELL = 32;
const COLS = 16;
const ROWS = 32;
const ALPHA_THRESHOLD = 128;

const TILESET_PATH = path.join(
  root,
  "assets/tileset/Office Tileset/Office Tileset All 32x32.png",
);
const OUTPUT_DIR = path.join(root, "webview-ui/public/assets/furniture");

// No rows are skipped — partition tiles (solid-color panels) are extracted
// as individual tiles. They're usable as floor/wall accents if desired.

// ── Category mapping by row ─────────────────────────────────────────────
function getCategory(row: number): string {
  if (row <= 5) return "desks";
  if (row <= 12) return "storage";
  if (row === 13) return "chairs";
  if (row <= 15) return "misc";
  if (row === 16) return "decor";
  if (row <= 18) return "wall";
  if (row <= 20) return "electronics";
  if (row <= 22) return "decor";
  return "misc";
}

function getLabelPrefix(row: number): string {
  const map: Record<string, string> = {
    desks: "Desk",
    storage: "Shelf",
    chairs: "Chair",
    misc: "Item",
    decor: "Decor",
    wall: "Wall Art",
    electronics: "Tech",
  };
  return map[getCategory(row)] || "Item";
}

// ── Annotation table ────────────────────────────────────────────────────
// Map (col,row) → multi-tile info. Unannotated cells default to 1×1.
// Adjust positions/sizes here if extracted sprites look wrong.
interface CellAnnotation {
  w: number;
  h: number;
  label?: string;
  category?: string;
  isDesk?: boolean;
  canPlaceOnWalls?: boolean;
  canPlaceOnSurfaces?: boolean;
  groupId?: string;
  orientation?: string;
}

const annotations = new Map<string, CellAnnotation>();

function ann(col: number, row: number, a: CellAnnotation): void {
  annotations.set(`${col},${row}`, a);
}

// ── Chair rotation groups ───────────────────────────────────────────────
// Each group: 4 consecutive columns = front, right, back, left orientations.
// The client's buildDynamicCatalog() auto-builds rotation controls from these.
const ORIENTATIONS = ["front", "right", "back", "left"] as const;

function chairGroup(
  groupId: string,
  startCol: number,
  row: number,
  label: string,
): void {
  for (let i = 0; i < 4; i++) {
    ann(startCol + i, row, {
      w: 1,
      h: 1,
      label: `${label} - ${ORIENTATIONS[i].charAt(0).toUpperCase() + ORIENTATIONS[i].slice(1)}`,
      category: "chairs",
      groupId,
      orientation: ORIENTATIONS[i],
    });
  }
}

// Chair rotation groups — positions TBD after visual inspection of extracted sprites.
// To add a group: chairGroup("group-id", startCol, row, "Label")
// Example: chairGroup("armchair-red", 0, 20, "Red Armchair");

// ── Multi-tile desks (rows 0-5) ─────────────────────────────────────────
// These positions are based on visual inspection of the tileset.
// If an extracted sprite looks wrong, adjust col/row or change w/h.
ann(1, 0, { w: 2, h: 1, label: "Wood Desk Front A", isDesk: true });
ann(4, 0, { w: 2, h: 1, label: "Wood Desk Front B", isDesk: true });
ann(1, 1, { w: 2, h: 1, label: "Wood Desk Side A", isDesk: true });
ann(4, 1, { w: 2, h: 1, label: "Wood Desk Side B", isDesk: true });
ann(0, 2, { w: 2, h: 1, label: "Metal Desk Front A", isDesk: true });
ann(3, 2, { w: 2, h: 1, label: "Metal Desk Front B", isDesk: true });
ann(0, 3, { w: 2, h: 1, label: "Metal Desk Side A", isDesk: true });
ann(3, 3, { w: 2, h: 1, label: "Metal Desk Side B", isDesk: true });

// ── Multi-tile storage (rows 10-12) ─────────────────────────────────────
ann(8, 10, { w: 2, h: 2, label: "Wood Bookshelf Large A" });
ann(10, 10, { w: 2, h: 2, label: "Wood Bookshelf Large B" });
ann(12, 10, { w: 2, h: 2, label: "Metal Bookshelf Large A" });
ann(14, 10, { w: 2, h: 2, label: "Metal Bookshelf Large B" });

// ── Multi-tile misc (rows 14-15) ────────────────────────────────────────
ann(2, 14, { w: 2, h: 1, label: "Gray Couch" });
ann(4, 14, { w: 2, h: 1, label: "Brown Couch" });

// ── Multi-tile wall art (row 18) ────────────────────────────────────────
ann(0, 18, { w: 2, h: 1, label: "Landscape Painting", canPlaceOnWalls: true });
ann(2, 18, { w: 2, h: 1, label: "Sky Painting", canPlaceOnWalls: true });
ann(4, 18, { w: 2, h: 1, label: "Abstract Painting", canPlaceOnWalls: true });

// ── Multi-tile electronics (rows 19-20) ─────────────────────────────────
ann(0, 19, { w: 2, h: 1, label: "Whiteboard A", category: "electronics" });
ann(2, 19, { w: 2, h: 1, label: "Whiteboard B", category: "electronics" });
ann(4, 19, { w: 2, h: 1, label: "Whiteboard C", category: "electronics" });

// ── Surface-placeable items ─────────────────────────────────────────────
// Small items that go on top of desks (monitors, lamps, etc.)
// These are in the electronics/decor rows — mark with canPlaceOnSurfaces
// (Add more as needed after visual inspection of extracted sprites)

// ── Helpers ─────────────────────────────────────────────────────────────
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isCellEmpty(png: PNG, col: number, row: number): boolean {
  const sx = col * CELL;
  const sy = row * CELL;
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const idx = ((sy + y) * png.width + sx + x) * 4;
      if (png.data[idx + 3] >= ALPHA_THRESHOLD) return false;
    }
  }
  return true;
}

function extractRegion(
  png: PNG,
  sx: number,
  sy: number,
  w: number,
  h: number,
): Buffer {
  const dst = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const srcIdx = ((sy + y) * png.width + sx + x) * 4;
      const dstIdx = (y * w + x) * 4;
      dst.data[dstIdx] = png.data[srcIdx];
      dst.data[dstIdx + 1] = png.data[srcIdx + 1];
      dst.data[dstIdx + 2] = png.data[srcIdx + 2];
      dst.data[dstIdx + 3] = png.data[srcIdx + 3];
    }
  }
  return PNG.sync.write(dst);
}

// ── Main ────────────────────────────────────────────────────────────────
function main(): void {
  const pngBuffer = fs.readFileSync(TILESET_PATH);
  const png = PNG.sync.read(pngBuffer);

  console.log(
    `Tileset: ${png.width}x${png.height} (${COLS} cols x ${ROWS} rows of ${CELL}x${CELL})`,
  );

  // Build set of cells covered by multi-tile annotations (non-origin cells)
  const covered = new Set<string>();
  for (const [key, a] of annotations) {
    const [col, row] = key.split(",").map(Number);
    for (let dy = 0; dy < a.h; dy++) {
      for (let dx = 0; dx < a.w; dx++) {
        if (dx === 0 && dy === 0) continue;
        covered.add(`${col + dx},${row + dy}`);
      }
    }
  }

  // Create output directory
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const catalog: Array<Record<string, unknown>> = [];
  const usedIds = new Set<string>();
  let extracted = 0;
  let empty = 0;

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const key = `${col},${row}`;

      // Skip cells that are continuation of a multi-tile item
      if (covered.has(key)) continue;

      const cellAnn = annotations.get(key);
      const w = cellAnn?.w ?? 1;
      const h = cellAnn?.h ?? 1;

      // Bounds check
      if (col + w > COLS || row + h > ROWS) {
        console.warn(`  Annotation at (${col},${row}) extends beyond grid, skipping`);
        continue;
      }

      // Check if region has any non-transparent pixels
      let hasPixels = false;
      outer: for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          if (!isCellEmpty(png, col + dx, row + dy)) {
            hasPixels = true;
            break outer;
          }
        }
      }
      if (!hasPixels) {
        empty++;
        continue;
      }

      // Generate unique ID
      let baseId: string;
      if (cellAnn?.label) {
        baseId = slugify(cellAnn.label);
      } else {
        baseId = `${getLabelPrefix(row).toLowerCase()}_r${row}_c${col}`;
      }
      let id = baseId;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${baseId}-${suffix++}`;
      }
      usedIds.add(id);

      // Extract sprite region
      const pixelW = w * CELL;
      const pixelH = h * CELL;
      const spriteData = extractRegion(png, col * CELL, row * CELL, pixelW, pixelH);

      // Write PNG
      const fileName = `${id}.png`;
      fs.writeFileSync(path.join(OUTPUT_DIR, fileName), spriteData);

      // Build catalog entry
      const category = cellAnn?.category ?? getCategory(row);
      const label = cellAnn?.label ?? `${getLabelPrefix(row)} ${row}-${col}`;
      const isDesk = cellAnn?.isDesk ?? false;
      const canPlaceOnWalls = cellAnn?.canPlaceOnWalls ?? category === "wall";

      const entry: Record<string, unknown> = {
        id,
        name: id,
        label,
        category,
        file: `furniture/${fileName}`,
        width: pixelW,
        height: pixelH,
        footprintW: w,
        footprintH: h,
        isDesk,
        canPlaceOnWalls,
      };

      if (cellAnn?.groupId) entry.groupId = cellAnn.groupId;
      if (cellAnn?.orientation) entry.orientation = cellAnn.orientation;
      if (cellAnn?.canPlaceOnSurfaces) entry.canPlaceOnSurfaces = true;

      catalog.push(entry);
      extracted++;
    }
  }

  // Write catalog JSON
  const catalogPath = path.join(OUTPUT_DIR, "furniture-catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({ assets: catalog }, null, 2));

  // Summary
  const groupIds = new Set([...annotations.values()].filter((a) => a.groupId).map((a) => a.groupId));
  console.log(`\nResults:`);
  console.log(`  Extracted: ${extracted} furniture assets`);
  console.log(`  Empty cells: ${empty}`);
  console.log(`  Multi-tile annotations: ${annotations.size}`);
  console.log(`  Rotation groups: ${groupIds.size}`);
  console.log(`\nOutput:`);
  console.log(`  PNGs:    ${OUTPUT_DIR}/`);
  console.log(`  Catalog: ${catalogPath}`);
}

main();
