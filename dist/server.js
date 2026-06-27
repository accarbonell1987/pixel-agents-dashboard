// server/index.ts
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { join as join4, dirname as dirname3 } from "path";
import { homedir as homedir3 } from "os";
import { fileURLToPath } from "url";
import { existsSync as existsSync3, readFileSync as readFileSync3, writeFileSync, mkdirSync } from "fs";

// server/agentsRoomWatcher.ts
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { EventEmitter } from "events";
var CONFIG_PATH = join(homedir(), ".agentsroom", "config.json");
var POLL_INTERVAL_MS = 1500;
function readJson(path3) {
  if (!existsSync(path3)) return null;
  try {
    return JSON.parse(readFileSync(path3, "utf-8"));
  } catch {
    return null;
  }
}
function signature(a) {
  return `${a.role}|${a.title}|${a.needsInput}|${a.projectName}|${a.claudeSessionId}`;
}
var AgentsRoomWatcher = class extends EventEmitter {
  agents = /* @__PURE__ */ new Map();
  timer = null;
  start() {
    this.scan();
    this.timer = setInterval(() => this.scan(), POLL_INTERVAL_MS);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  scan() {
    const config = readJson(CONFIG_PATH);
    const projects = config?.projects ?? [];
    const seen = /* @__PURE__ */ new Set();
    for (const proj of projects) {
      const roomDir = join(proj.directoryPath, ".agentsroom");
      const roster = readJson(join(roomDir, "agents-cache.json"))?.data ?? [];
      for (const entry of roster) {
        const key = entry.id;
        const status = readJson(join(roomDir, "sessions", `${key}.json`));
        const next = {
          key,
          projectName: proj.name,
          role: entry.role ?? "agent",
          model: entry.model ?? "",
          title: status?.title ?? "",
          type: status?.type ?? "",
          needsInput: status?.needsInput === true,
          claudeSessionId: entry.claudeSessionId ?? "",
          projectColor: proj.colorHex ?? "#888888"
        };
        seen.add(key);
        const prev = this.agents.get(key);
        if (!prev) {
          this.agents.set(key, next);
          this.emit("agentJoined", next);
        } else if (signature(prev) !== signature(next)) {
          this.agents.set(key, next);
          this.emit("agentChanged", next);
        }
      }
    }
    for (const key of [...this.agents.keys()]) {
      if (!seen.has(key)) {
        this.agents.delete(key);
        this.emit("agentLeft", key);
      }
    }
  }
};

// server/watcher.ts
import { watch } from "chokidar";
import { statSync, readdirSync, openSync, readSync, closeSync } from "fs";
import { join as join2, basename, dirname } from "path";
import { homedir as homedir2 } from "os";
import { EventEmitter as EventEmitter2 } from "events";
var CLAUDE_PROJECTS_DIR = join2(homedir2(), ".claude", "projects");
var ACTIVE_THRESHOLD_MS = 6e5;
var POLL_INTERVAL_MS2 = 1e3;
var JsonlWatcher = class extends EventEmitter2 {
  files = /* @__PURE__ */ new Map();
  watcher = null;
  pollInterval = null;
  start() {
    this.scanForActiveFiles();
    this.watcher = watch(CLAUDE_PROJECTS_DIR, {
      ignoreInitial: true,
      depth: 3
    });
    this.watcher.on("add", (filePath) => {
      if (filePath.endsWith(".jsonl")) {
        this.addFile(filePath);
      }
    });
    this.pollInterval = setInterval(() => this.pollFiles(), POLL_INTERVAL_MS2);
  }
  stop() {
    this.watcher?.close();
    if (this.pollInterval) clearInterval(this.pollInterval);
  }
  scanForActiveFiles() {
    try {
      const dirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const dirPath = join2(CLAUDE_PROJECTS_DIR, dir.name);
        try {
          const files = readdirSync(dirPath);
          for (const f of files) {
            if (!f.endsWith(".jsonl")) continue;
            const filePath = join2(dirPath, f);
            const stat = statSync(filePath);
            if (Date.now() - stat.mtimeMs < ACTIVE_THRESHOLD_MS) {
              this.addFile(filePath);
            }
          }
        } catch {
        }
      }
    } catch {
    }
  }
  addFile(filePath) {
    if (this.files.has(filePath)) return;
    const sessionId = basename(filePath, ".jsonl");
    const projectDirName = basename(dirname(filePath));
    const parts = projectDirName.split("-").filter(Boolean);
    const projectName = parts[parts.length - 1] || sessionId.slice(0, 8);
    const file = {
      path: filePath,
      sessionId,
      projectName,
      offset: 0,
      lineBuffer: ""
    };
    this.files.set(filePath, file);
    this.emit("fileAdded", file);
    this.readNewLines(file);
  }
  pollFiles() {
    for (const [path3, file] of this.files) {
      try {
        const stat = statSync(path3);
        if (stat.size > file.offset) {
          this.readNewLines(file);
        }
        if (Date.now() - stat.mtimeMs > ACTIVE_THRESHOLD_MS) {
          this.files.delete(path3);
          this.emit("fileRemoved", file);
        }
      } catch {
        this.files.delete(path3);
        this.emit("fileRemoved", file);
      }
    }
  }
  readNewLines(file) {
    try {
      const stat = statSync(file.path);
      if (stat.size <= file.offset) return;
      const buf = Buffer.alloc(stat.size - file.offset);
      const fd = openSync(file.path, "r");
      readSync(fd, buf, 0, buf.length, file.offset);
      closeSync(fd);
      file.offset = stat.size;
      const text = file.lineBuffer + buf.toString("utf-8");
      const lines = text.split("\n");
      file.lineBuffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          this.emit("line", file, line);
        }
      }
    } catch {
    }
  }
  getActiveFiles() {
    return Array.from(this.files.values());
  }
};

// server/parser.ts
import * as path from "path";
var READING_TOOLS = /* @__PURE__ */ new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
var PERMISSION_EXEMPT_TOOLS = /* @__PURE__ */ new Set(["Task", "AskUserQuestion"]);
var PERMISSION_TIMER_DELAY_MS = 7e3;
var TEXT_IDLE_DELAY_MS = 5e3;
var TOOL_DONE_DELAY_MS = 300;
var BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
var TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;
var IDLE_ACTIVITY_TIMEOUT_MS = 12e4;
var waitingTimers = /* @__PURE__ */ new Map();
var permissionTimers = /* @__PURE__ */ new Map();
var idleTimeoutTimers = /* @__PURE__ */ new Map();
function formatToolStatus(toolName, input) {
  const base = (p) => typeof p === "string" ? path.basename(p) : "";
  switch (toolName) {
    case "Read":
      return `Reading ${base(input.file_path)}`;
    case "Edit":
      return `Editing ${base(input.file_path)}`;
    case "Write":
      return `Writing ${base(input.file_path)}`;
    case "Bash": {
      const cmd = input.command || "";
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + "\u2026" : cmd}`;
    }
    case "Glob":
      return "Searching files";
    case "Grep":
      return "Searching code";
    case "WebFetch":
      return "Fetching web content";
    case "WebSearch":
      return "Searching the web";
    case "Task": {
      const desc = typeof input.description === "string" ? input.description : "";
      return desc ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + "\u2026" : desc}` : "Running subtask";
    }
    case "AskUserQuestion":
      return "Waiting for your answer";
    case "EnterPlanMode":
      return "Planning";
    case "NotebookEdit":
      return "Editing notebook";
    default:
      return `Using ${toolName}`;
  }
}
function cancelTimer(agentId, timers) {
  const t = timers.get(agentId);
  if (t) {
    clearTimeout(t);
    timers.delete(agentId);
  }
}
function startWaitingTimer(agent, emit) {
  cancelTimer(agent.id, waitingTimers);
  waitingTimers.set(
    agent.id,
    setTimeout(() => {
      waitingTimers.delete(agent.id);
      agent.isWaiting = true;
      agent.hadToolsInTurn = false;
      emit({ type: "agentStatus", id: agent.id, status: "waiting" });
    }, TEXT_IDLE_DELAY_MS)
  );
}
function startIdleTimeout(agent, emit) {
  cancelTimer(agent.id, idleTimeoutTimers);
  idleTimeoutTimers.set(
    agent.id,
    setTimeout(() => {
      idleTimeoutTimers.delete(agent.id);
      if (agent.activity !== "idle" && agent.activity !== "waiting") {
        clearAgentActivity(agent, emit);
        agent.isWaiting = true;
        agent.hadToolsInTurn = false;
        agent.activity = "waiting";
        emit({ type: "agentStatus", id: agent.id, status: "waiting" });
      }
    }, IDLE_ACTIVITY_TIMEOUT_MS)
  );
}
function startPermissionTimer(agent, emit) {
  cancelTimer(agent.id, permissionTimers);
  permissionTimers.set(
    agent.id,
    setTimeout(() => {
      permissionTimers.delete(agent.id);
      let hasNonExempt = false;
      for (const [, toolName] of agent.activeToolNames) {
        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          hasNonExempt = true;
          break;
        }
      }
      if (!hasNonExempt) {
        for (const [, subNames] of agent.activeSubagentToolNames) {
          for (const [, toolName] of subNames) {
            if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
              hasNonExempt = true;
              break;
            }
          }
          if (hasNonExempt) break;
        }
      }
      if (hasNonExempt && !agent.permissionSent) {
        agent.permissionSent = true;
        emit({ type: "agentToolPermission", id: agent.id });
      }
    }, PERMISSION_TIMER_DELAY_MS)
  );
}
function processTranscriptLine(line, agent, emit) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  const type = record.type;
  if (type === "assistant") {
    handleAssistantMessage(record, agent, emit);
  } else if (type === "user") {
    handleUserMessage(record, agent, emit);
  } else if (type === "system") {
    handleSystemMessage(record, agent, emit);
  } else if (type === "progress") {
    handleProgressMessage(record, agent, emit);
  }
}
function handleAssistantMessage(record, agent, emit) {
  const message = record.message;
  if (!message?.content) return;
  const content = message.content;
  if (!Array.isArray(content)) return;
  const hasToolUse = content.some((b) => b.type === "tool_use");
  if (hasToolUse) {
    cancelTimer(agent.id, waitingTimers);
    agent.isWaiting = false;
    agent.hadToolsInTurn = true;
    emit({ type: "agentStatus", id: agent.id, status: "active" });
    let hasNonExemptTool = false;
    for (const block of content) {
      if (block.type === "tool_use" && block.id) {
        const toolId = block.id;
        const toolName = block.name || "";
        const input = block.input || {};
        const status = formatToolStatus(toolName, input);
        agent.activeTools.set(toolId, { toolId, toolName, status });
        agent.activeToolNames.set(toolId, toolName);
        agent.lastActivityTime = Date.now();
        const activity = READING_TOOLS.has(toolName) ? "reading" : "typing";
        agent.activity = activity;
        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          hasNonExemptTool = true;
        }
        emit({ type: "agentToolStart", id: agent.id, toolId, status });
      }
    }
    if (hasNonExemptTool) {
      agent.permissionSent = false;
      startPermissionTimer(agent, emit);
    }
    startIdleTimeout(agent, emit);
  } else if (content.some((b) => b.type === "text") && !agent.hadToolsInTurn) {
    startWaitingTimer(agent, emit);
  }
}
function handleUserMessage(record, agent, emit) {
  const message = record.message;
  if (!message?.content) return;
  const content = message.content;
  if (Array.isArray(content)) {
    const blocks = content;
    const hasToolResult = blocks.some((b) => b.type === "tool_result");
    if (hasToolResult) {
      for (const block of blocks) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const completedToolId = block.tool_use_id;
          if (agent.activeToolNames.get(completedToolId) === "Task") {
            agent.activeSubagentToolIds.delete(completedToolId);
            agent.activeSubagentToolNames.delete(completedToolId);
            emit({
              type: "subagentClear",
              id: agent.id,
              parentToolId: completedToolId
            });
          }
          agent.activeTools.delete(completedToolId);
          agent.activeToolNames.delete(completedToolId);
          const toolId = completedToolId;
          setTimeout(() => {
            emit({ type: "agentToolDone", id: agent.id, toolId });
          }, TOOL_DONE_DELAY_MS);
        }
      }
      if (agent.activeTools.size === 0) {
        agent.hadToolsInTurn = false;
      }
    } else {
      cancelTimer(agent.id, waitingTimers);
      cancelTimer(agent.id, idleTimeoutTimers);
      clearAgentActivity(agent, emit);
      agent.hadToolsInTurn = false;
    }
  } else if (typeof content === "string" && content.trim()) {
    cancelTimer(agent.id, waitingTimers);
    cancelTimer(agent.id, idleTimeoutTimers);
    clearAgentActivity(agent, emit);
    agent.hadToolsInTurn = false;
  }
}
function handleSystemMessage(record, agent, emit) {
  const subtype = record.subtype;
  if (subtype === "turn_duration") {
    cancelTimer(agent.id, waitingTimers);
    cancelTimer(agent.id, permissionTimers);
    cancelTimer(agent.id, idleTimeoutTimers);
    if (agent.activeTools.size > 0) {
      agent.activeTools.clear();
      agent.activeToolNames.clear();
      agent.activeSubagentToolIds.clear();
      agent.activeSubagentToolNames.clear();
      emit({ type: "agentToolsClear", id: agent.id });
    }
    agent.isWaiting = true;
    agent.permissionSent = false;
    agent.hadToolsInTurn = false;
    agent.activity = "waiting";
    emit({ type: "agentStatus", id: agent.id, status: "waiting" });
  }
}
function handleProgressMessage(record, agent, emit) {
  const parentToolId = record.parentToolUseID;
  if (!parentToolId) return;
  const data = record.data;
  if (!data) return;
  const dataType = data.type;
  if (dataType === "bash_progress" || dataType === "mcp_progress") {
    if (agent.activeTools.has(parentToolId)) {
      startPermissionTimer(agent, emit);
    }
    return;
  }
  if (agent.activeToolNames.get(parentToolId) !== "Task") return;
  const msg = data.message;
  if (!msg) return;
  const msgType = msg.type;
  const innerMsg = msg.message;
  const content = innerMsg?.content;
  if (!Array.isArray(content)) return;
  if (msgType === "assistant") {
    let hasNonExemptSubTool = false;
    for (const block of content) {
      if (block.type === "tool_use" && block.id) {
        const toolId = block.id;
        const toolName = block.name || "";
        const input = block.input || {};
        const status = formatToolStatus(toolName, input);
        let subTools = agent.activeSubagentToolIds.get(parentToolId);
        if (!subTools) {
          subTools = /* @__PURE__ */ new Set();
          agent.activeSubagentToolIds.set(parentToolId, subTools);
        }
        subTools.add(toolId);
        let subNames = agent.activeSubagentToolNames.get(parentToolId);
        if (!subNames) {
          subNames = /* @__PURE__ */ new Map();
          agent.activeSubagentToolNames.set(parentToolId, subNames);
        }
        subNames.set(toolId, toolName);
        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          hasNonExemptSubTool = true;
        }
        emit({
          type: "subagentToolStart",
          id: agent.id,
          parentToolId,
          toolId,
          status
        });
      }
    }
    if (hasNonExemptSubTool) {
      startPermissionTimer(agent, emit);
    }
  } else if (msgType === "user") {
    for (const block of content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        const toolId = block.tool_use_id;
        const subTools = agent.activeSubagentToolIds.get(parentToolId);
        if (subTools) subTools.delete(toolId);
        const subNames = agent.activeSubagentToolNames.get(parentToolId);
        if (subNames) subNames.delete(toolId);
        setTimeout(() => {
          emit({
            type: "subagentToolDone",
            id: agent.id,
            parentToolId,
            toolId
          });
        }, TOOL_DONE_DELAY_MS);
      }
    }
  }
}
function clearAgentActivity(agent, emit) {
  cancelTimer(agent.id, permissionTimers);
  cancelTimer(agent.id, idleTimeoutTimers);
  if (agent.activeTools.size > 0) {
    agent.activeTools.clear();
    agent.activeToolNames.clear();
    agent.activeSubagentToolIds.clear();
    agent.activeSubagentToolNames.clear();
    emit({ type: "agentToolsClear", id: agent.id });
  }
  if (agent.permissionSent) {
    agent.permissionSent = false;
    emit({ type: "agentToolPermissionClear", id: agent.id });
  }
  agent.activity = "idle";
}

// server/assetLoader.ts
import * as fs from "fs";
import * as path2 from "path";
import { PNG } from "pngjs";
var PNG_ALPHA_THRESHOLD = 128;
var WALL_PIECE_WIDTH = 16;
var WALL_PIECE_HEIGHT = 32;
var WALL_GRID_COLS = 4;
var WALL_BITMASK_COUNT = 16;
var FLOOR_PATTERN_COUNT = 7;
var FLOOR_TILE_SIZE = 16;
var CHARACTER_DIRECTIONS = ["down", "up", "right"];
var CHAR_FRAME_W = 16;
var CHAR_FRAME_H = 32;
var CHAR_FRAMES_PER_ROW = 7;
var CHAR_COUNT = 6;
function pngToSpriteData(pngBuffer, width, height) {
  try {
    const png = PNG.sync.read(pngBuffer);
    const sprite = [];
    const data = png.data;
    for (let y = 0; y < height; y++) {
      const row = [];
      for (let x = 0; x < width; x++) {
        const pixelIndex = (y * png.width + x) * 4;
        const r = data[pixelIndex];
        const g = data[pixelIndex + 1];
        const b = data[pixelIndex + 2];
        const a = data[pixelIndex + 3];
        if (a < PNG_ALPHA_THRESHOLD) {
          row.push("");
        } else {
          const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase();
          row.push(hex);
        }
      }
      sprite.push(row);
    }
    return sprite;
  } catch (err) {
    console.warn(`Failed to parse PNG: ${err instanceof Error ? err.message : err}`);
    const sprite = [];
    for (let y = 0; y < height; y++) {
      sprite.push(new Array(width).fill(""));
    }
    return sprite;
  }
}
function loadCharacterSprites(assetsRoot2) {
  try {
    const charDir = path2.join(assetsRoot2, "characters");
    const characters = [];
    for (let ci = 0; ci < CHAR_COUNT; ci++) {
      const filePath = path2.join(charDir, `char_${ci}.png`);
      if (!fs.existsSync(filePath)) {
        console.log(`[AssetLoader] No character sprite found at: ${filePath}`);
        return null;
      }
      const pngBuffer = fs.readFileSync(filePath);
      const png = PNG.sync.read(pngBuffer);
      const charData = { down: [], up: [], right: [] };
      for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx++) {
        const dir = CHARACTER_DIRECTIONS[dirIdx];
        const rowOffsetY = dirIdx * CHAR_FRAME_H;
        const frames = [];
        for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
          const sprite = [];
          const frameOffsetX = f * CHAR_FRAME_W;
          for (let y = 0; y < CHAR_FRAME_H; y++) {
            const row = [];
            for (let x = 0; x < CHAR_FRAME_W; x++) {
              const idx = ((rowOffsetY + y) * png.width + (frameOffsetX + x)) * 4;
              const r = png.data[idx];
              const g = png.data[idx + 1];
              const b = png.data[idx + 2];
              const a = png.data[idx + 3];
              if (a < PNG_ALPHA_THRESHOLD) {
                row.push("");
              } else {
                row.push(
                  `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase()
                );
              }
            }
            sprite.push(row);
          }
          frames.push(sprite);
        }
        charData[dir] = frames;
      }
      characters.push(charData);
    }
    console.log(
      `[AssetLoader] Loaded ${characters.length} character sprites (${CHAR_FRAMES_PER_ROW} frames x 3 directions each)`
    );
    return { characters };
  } catch (err) {
    console.error(`[AssetLoader] Error loading character sprites: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
function loadWallTiles(assetsRoot2) {
  try {
    const wallPath = path2.join(assetsRoot2, "walls.png");
    if (!fs.existsSync(wallPath)) {
      console.log("[AssetLoader] No walls.png found at:", wallPath);
      return null;
    }
    const pngBuffer = fs.readFileSync(wallPath);
    const png = PNG.sync.read(pngBuffer);
    const sprites = [];
    for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
      const ox = mask % WALL_GRID_COLS * WALL_PIECE_WIDTH;
      const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
      const sprite = [];
      for (let r = 0; r < WALL_PIECE_HEIGHT; r++) {
        const row = [];
        for (let c = 0; c < WALL_PIECE_WIDTH; c++) {
          const idx = ((oy + r) * png.width + (ox + c)) * 4;
          const rv = png.data[idx];
          const gv = png.data[idx + 1];
          const bv = png.data[idx + 2];
          const av = png.data[idx + 3];
          if (av < PNG_ALPHA_THRESHOLD) {
            row.push("");
          } else {
            row.push(
              `#${rv.toString(16).padStart(2, "0")}${gv.toString(16).padStart(2, "0")}${bv.toString(16).padStart(2, "0")}`.toUpperCase()
            );
          }
        }
        sprite.push(row);
      }
      sprites.push(sprite);
    }
    console.log(`[AssetLoader] Loaded ${sprites.length} wall tile pieces`);
    return { sprites };
  } catch (err) {
    console.error(`[AssetLoader] Error loading wall tiles: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
function loadFloorTiles(assetsRoot2) {
  try {
    const floorPath = path2.join(assetsRoot2, "floors.png");
    if (!fs.existsSync(floorPath)) {
      return null;
    }
    const pngBuffer = fs.readFileSync(floorPath);
    const png = PNG.sync.read(pngBuffer);
    const sprites = [];
    for (let t = 0; t < FLOOR_PATTERN_COUNT; t++) {
      const sprite = [];
      for (let y = 0; y < FLOOR_TILE_SIZE; y++) {
        const row = [];
        for (let x = 0; x < FLOOR_TILE_SIZE; x++) {
          const px = t * FLOOR_TILE_SIZE + x;
          const idx = (y * png.width + px) * 4;
          const r = png.data[idx];
          const g = png.data[idx + 1];
          const b = png.data[idx + 2];
          const a = png.data[idx + 3];
          if (a < PNG_ALPHA_THRESHOLD) {
            row.push("");
          } else {
            row.push(
              `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase()
            );
          }
        }
        sprite.push(row);
      }
      sprites.push(sprite);
    }
    console.log(`[AssetLoader] Loaded ${sprites.length} floor tile patterns`);
    return { sprites };
  } catch (err) {
    console.error(`[AssetLoader] Error loading floor tiles: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
function loadFurnitureAssets(assetsRoot2) {
  try {
    const catalogPath = path2.join(assetsRoot2, "furniture", "furniture-catalog.json");
    if (!fs.existsSync(catalogPath)) {
      return null;
    }
    const catalogContent = fs.readFileSync(catalogPath, "utf-8");
    const catalogData = JSON.parse(catalogContent);
    const catalog = catalogData.assets || [];
    const sprites = {};
    for (const asset of catalog) {
      try {
        let filePath = asset.file;
        if (!filePath.startsWith("assets/")) {
          filePath = `assets/${filePath}`;
        }
        const assetPath = path2.join(path2.dirname(assetsRoot2), filePath);
        if (!fs.existsSync(assetPath)) continue;
        const pngBuffer = fs.readFileSync(assetPath);
        sprites[asset.id] = pngToSpriteData(pngBuffer, asset.width, asset.height);
      } catch {
      }
    }
    console.log(`[AssetLoader] Loaded ${Object.keys(sprites).length} / ${catalog.length} furniture assets`);
    return { catalog, sprites };
  } catch (err) {
    console.error(`[AssetLoader] Error loading furniture assets: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
function loadDefaultLayout(assetsRoot2) {
  try {
    const layoutPath = path2.join(assetsRoot2, "default-layout.json");
    if (!fs.existsSync(layoutPath)) {
      console.log("[AssetLoader] No default-layout.json found at:", layoutPath);
      return null;
    }
    const content = fs.readFileSync(layoutPath, "utf-8");
    const layout = JSON.parse(content);
    console.log(`[AssetLoader] Loaded default layout (${layout.cols}x${layout.rows})`);
    return layout;
  } catch (err) {
    console.error(`[AssetLoader] Error loading default layout: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// server/index.ts
var __dirname = dirname3(fileURLToPath(import.meta.url));
var PORT = parseInt(process.env.PORT || "3456", 10);
var IDLE_SHUTDOWN_MS = 6e5;
var agents = /* @__PURE__ */ new Map();
var idByKey = /* @__PURE__ */ new Map();
var sessionToId = /* @__PURE__ */ new Map();
var parserState = /* @__PURE__ */ new Map();
var nextAgentId = 1;
var clients = /* @__PURE__ */ new Set();
var lastActivityTime = Date.now();
var devAssetsRoot = join4(__dirname, "..", "webview-ui", "public", "assets");
var prodAssetsRoot = join4(__dirname, "public", "assets");
var assetsRoot = existsSync3(devAssetsRoot) ? devAssetsRoot : prodAssetsRoot;
console.log(`[Server] Loading assets from: ${assetsRoot}`);
var characterSprites = loadCharacterSprites(assetsRoot);
var wallTiles = loadWallTiles(assetsRoot);
var floorTiles = loadFloorTiles(assetsRoot);
var furnitureAssets = loadFurnitureAssets(assetsRoot);
var persistDir = join4(homedir3(), ".pixel-agents");
var persistedLayoutPath = join4(persistDir, "layout.json");
var persistedSeatsPath = join4(persistDir, "agent-seats.json");
function loadLayout() {
  if (existsSync3(persistedLayoutPath)) {
    try {
      const content = readFileSync3(persistedLayoutPath, "utf-8");
      const layout = JSON.parse(content);
      console.log(`[Server] Loaded persisted layout from ${persistedLayoutPath}`);
      return layout;
    } catch (err) {
      console.warn(`[Server] Failed to load persisted layout: ${err instanceof Error ? err.message : err}`);
    }
  }
  return loadDefaultLayout(assetsRoot);
}
function loadPersistedSeats() {
  if (existsSync3(persistedSeatsPath)) {
    try {
      const content = readFileSync3(persistedSeatsPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  return null;
}
var currentLayout = loadLayout();
var persistedSeats = loadPersistedSeats();
var app = express();
app.use(express.static(join4(__dirname, "public")));
var server = createServer(app);
var wss = new WebSocketServer({ server });
var HEARTBEAT_INTERVAL_MS = 3e4;
setInterval(() => {
  for (const ws of clients) {
    if (ws.__isAlive === false) {
      clients.delete(ws);
      ws.terminate();
      continue;
    }
    ws.__isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}
function sendInitialData(ws) {
  ws.send(JSON.stringify({ type: "settingsLoaded", soundEnabled: false }));
  if (characterSprites) {
    ws.send(JSON.stringify({ type: "characterSpritesLoaded", characters: characterSprites.characters }));
  }
  if (wallTiles) {
    ws.send(JSON.stringify({ type: "wallTilesLoaded", sprites: wallTiles.sprites }));
  }
  if (floorTiles) {
    ws.send(JSON.stringify({ type: "floorTilesLoaded", sprites: floorTiles.sprites }));
  }
  if (furnitureAssets) {
    ws.send(
      JSON.stringify({
        type: "furnitureAssetsLoaded",
        catalog: furnitureAssets.catalog,
        sprites: furnitureAssets.sprites
      })
    );
  }
  const agentList = Array.from(agents.values());
  const agentIds = agentList.map((a) => a.id);
  const folderNames = {};
  const agentMeta = {};
  const projects = {};
  for (const a of agentList) {
    folderNames[a.id] = a.folderName;
    projects[a.id] = { name: a.projectName, color: a.projectColor };
    if (persistedSeats?.[a.id]) {
      const s = persistedSeats[a.id];
      agentMeta[a.id] = { palette: s.palette, hueShift: s.hueShift, seatId: s.seatId ?? void 0 };
    }
  }
  ws.send(JSON.stringify({ type: "existingAgents", agents: agentIds, folderNames, agentMeta, projects }));
  if (currentLayout) {
    ws.send(JSON.stringify({ type: "layoutLoaded", layout: currentLayout, version: 1 }));
  } else {
    ws.send(JSON.stringify({ type: "layoutLoaded", layout: null, version: 0 }));
  }
  for (const a of agentList) {
    if (a.needsInput) ws.send(JSON.stringify({ type: "agentToolPermission", id: a.id }));
  }
}
wss.on("connection", (ws) => {
  ws.__isAlive = true;
  ws.on("pong", () => {
    ws.__isAlive = true;
  });
  clients.add(ws);
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "webviewReady" || msg.type === "ready") {
        sendInitialData(ws);
      } else if (msg.type === "saveLayout") {
        try {
          mkdirSync(persistDir, { recursive: true });
          writeFileSync(persistedLayoutPath, JSON.stringify(msg.layout, null, 2));
          currentLayout = msg.layout;
          const data = JSON.stringify({ type: "layoutLoaded", layout: msg.layout, version: 1 });
          for (const client of clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(data);
            }
          }
        } catch (err) {
          console.error(`[Server] Failed to save layout: ${err instanceof Error ? err.message : err}`);
        }
      } else if (msg.type === "saveAgentSeats") {
        try {
          mkdirSync(persistDir, { recursive: true });
          writeFileSync(persistedSeatsPath, JSON.stringify(msg.seats, null, 2));
        } catch (err) {
          console.error(`[Server] Failed to save agent seats: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch {
    }
  });
  ws.on("close", () => clients.delete(ws));
});
var watcher = new AgentsRoomWatcher();
var ROLE_LABEL = {
  fullstack: "Full-Stack",
  frontend: "Frontend",
  backend: "Backend",
  qa: "QA",
  architect: "Architect",
  brainstormer: "Brainstormer",
  devops: "DevOps"
};
function labelFor(a) {
  const role = ROLE_LABEL[a.role] ?? a.role;
  const task = a.title.trim();
  return task ? `${role}: ${task}` : role;
}
function numericId(key) {
  let id = idByKey.get(key);
  if (id === void 0) {
    id = nextAgentId++;
    idByKey.set(key, id);
  }
  return id;
}
function linkSession(id, sessionId) {
  if (sessionId) sessionToId.set(sessionId, id);
}
watcher.on("agentJoined", (a) => {
  lastActivityTime = Date.now();
  const id = numericId(a.key);
  const folderName = labelFor(a);
  agents.set(a.key, { id, folderName, needsInput: a.needsInput, claudeSessionId: a.claudeSessionId, projectName: a.projectName, projectColor: a.projectColor });
  linkSession(id, a.claudeSessionId);
  broadcast({ type: "agentCreated", id, folderName, projectName: a.projectName, projectColor: a.projectColor });
  if (a.needsInput) broadcast({ type: "agentToolPermission", id });
  console.log(`Agent ${id} joined: ${folderName}`);
});
watcher.on("agentChanged", (a) => {
  lastActivityTime = Date.now();
  const id = numericId(a.key);
  const folderName = labelFor(a);
  const prev = agents.get(a.key);
  const respawned = prev !== void 0 && prev.folderName !== folderName;
  if (respawned) {
    broadcast({ type: "agentClosed", id });
    broadcast({ type: "agentCreated", id, folderName, projectName: a.projectName, projectColor: a.projectColor });
  }
  if (respawned || prev?.needsInput !== a.needsInput) {
    broadcast(a.needsInput ? { type: "agentToolPermission", id } : { type: "agentToolPermissionClear", id });
  }
  agents.set(a.key, { id, folderName, needsInput: a.needsInput, claudeSessionId: a.claudeSessionId, projectName: a.projectName, projectColor: a.projectColor });
  linkSession(id, a.claudeSessionId);
});
watcher.on("agentLeft", (key) => {
  const rec = agents.get(key);
  if (!rec) return;
  agents.delete(key);
  if (rec.claudeSessionId) {
    sessionToId.delete(rec.claudeSessionId);
    parserState.delete(rec.claudeSessionId);
  }
  broadcast({ type: "agentClosed", id: rec.id });
  console.log(`Agent ${rec.id} left`);
});
var jsonl = new JsonlWatcher();
jsonl.on("line", (file, line) => {
  const id = sessionToId.get(file.sessionId);
  if (id === void 0) return;
  let state = parserState.get(file.sessionId);
  if (!state) {
    state = {
      id,
      sessionId: file.sessionId,
      projectDir: "",
      projectName: "",
      jsonlFile: file.path,
      fileOffset: 0,
      lineBuffer: "",
      activity: "idle",
      activeTools: /* @__PURE__ */ new Map(),
      activeToolNames: /* @__PURE__ */ new Map(),
      activeSubagentToolIds: /* @__PURE__ */ new Map(),
      activeSubagentToolNames: /* @__PURE__ */ new Map(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastActivityTime: Date.now()
    };
    parserState.set(file.sessionId, state);
  }
  lastActivityTime = Date.now();
  processTranscriptLine(line, state, broadcast);
});
watcher.start();
jsonl.start();
server.listen(PORT, () => {
  console.log(`Pixel Agents server running at http://localhost:${PORT}`);
  console.log(`Watching ~/.agentsroom (agents) + ~/.claude/projects (live activity)...`);
});
setInterval(() => {
  if (agents.size === 0 && clients.size === 0 && Date.now() - lastActivityTime > IDLE_SHUTDOWN_MS) {
    console.log("No active sessions or clients for 10 minutes, shutting down...");
    watcher.stop();
    jsonl.stop();
    server.close();
    process.exit(0);
  }
}, 3e4);
process.on("SIGINT", () => {
  watcher.stop();
  server.close();
  process.exit(0);
});
