import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { AgentsRoomWatcher, type RoomAgent } from "./agentsRoomWatcher.js";
import { OpencodeWatcher } from "./opencodeWatcher.js";
import { JsonlWatcher, type WatchedFile } from "./watcher.js";
import { processTranscriptLine } from "./parser.js";
import {
  loadCharacterSprites,
  loadWallTiles,
  loadFloorTiles,
  loadFurnitureAssets,
  loadDefaultLayout,
} from "./assetLoader.js";
import type { TrackedAgent, ServerMessage } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3456", 10);
const IDLE_SHUTDOWN_MS = 600_000; // 10 minutes

// State
const agents = new Map<string, { id: number; folderName: string; needsInput: boolean; claudeSessionId: string; projectName: string; projectColor: string }>(); // agentId -> view
const idByKey = new Map<string, number>(); // agentId -> stable numeric id
const sessionToId = new Map<string, number>(); // claudeSessionId -> numeric id (for live JSONL activity)
const parserState = new Map<string, TrackedAgent>(); // claudeSessionId -> parser tool state
const ocToolState = new Map<string, string | null>(); // opencode agent key -> last emitted tool status
let nextAgentId = 1;
const clients = new Set<WebSocket>();
let lastActivityTime = Date.now();

// Load assets at startup
// In dev mode (tsx), __dirname is server/ so assets are at ../webview-ui/public/assets/
// In production (esbuild), __dirname is dist/ so assets are at ./public/assets/
const devAssetsRoot = join(__dirname, "..", "webview-ui", "public", "assets");
const prodAssetsRoot = join(__dirname, "public", "assets");
const assetsRoot = existsSync(devAssetsRoot) ? devAssetsRoot : prodAssetsRoot;

console.log(`[Server] Loading assets from: ${assetsRoot}`);

const characterSprites = loadCharacterSprites(assetsRoot);
const wallTiles = loadWallTiles(assetsRoot);
const floorTiles = loadFloorTiles(assetsRoot);
const furnitureAssets = loadFurnitureAssets(assetsRoot);

// Persistence directory
const persistDir = join(homedir(), ".pixel-agents");
const persistedLayoutPath = join(persistDir, "layout.json");
const persistedSeatsPath = join(persistDir, "agent-seats.json");

// Load layout: persisted first, then default
function loadLayout(): Record<string, unknown> | null {
  if (existsSync(persistedLayoutPath)) {
    try {
      const content = readFileSync(persistedLayoutPath, "utf-8");
      const layout = JSON.parse(content) as Record<string, unknown>;
      console.log(`[Server] Loaded persisted layout from ${persistedLayoutPath}`);
      return layout;
    } catch (err) {
      console.warn(`[Server] Failed to load persisted layout: ${err instanceof Error ? err.message : err}`);
    }
  }
  return loadDefaultLayout(assetsRoot);
}

function loadPersistedSeats(): Record<number, { palette: number; hueShift: number; seatId: string | null }> | null {
  if (existsSync(persistedSeatsPath)) {
    try {
      const content = readFileSync(persistedSeatsPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  return null;
}

let currentLayout = loadLayout();
const persistedSeats = loadPersistedSeats();

// Express app
const app = express();
// Serve production build
app.use(express.static(join(__dirname, "public")));

const server = createServer(app);

// WebSocket
const wss = new WebSocketServer({ server });

// Ping/pong heartbeat — keeps clients Set accurate for shutdown guard
const HEARTBEAT_INTERVAL_MS = 30_000;
setInterval(() => {
  for (const ws of clients) {
    if ((ws as unknown as Record<string, boolean>).__isAlive === false) {
      clients.delete(ws);
      ws.terminate();
      continue;
    }
    (ws as unknown as Record<string, boolean>).__isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function sendInitialData(ws: WebSocket): void {
  // Send settings
  ws.send(JSON.stringify({ type: "settingsLoaded", soundEnabled: false }));

  // Send character sprites
  if (characterSprites) {
    ws.send(JSON.stringify({ type: "characterSpritesLoaded", characters: characterSprites.characters }));
  }

  // Send wall tiles
  if (wallTiles) {
    ws.send(JSON.stringify({ type: "wallTilesLoaded", sprites: wallTiles.sprites }));
  }

  // Send floor tiles (optional)
  if (floorTiles) {
    ws.send(JSON.stringify({ type: "floorTilesLoaded", sprites: floorTiles.sprites }));
  }

  // Send furniture assets (optional)
  if (furnitureAssets) {
    ws.send(
      JSON.stringify({
        type: "furnitureAssetsLoaded",
        catalog: furnitureAssets.catalog,
        sprites: furnitureAssets.sprites,
      }),
    );
  }

  // Send existing agents with persisted seat metadata
  const agentList = Array.from(agents.values());
  const agentIds = agentList.map((a) => a.id);
  const folderNames: Record<number, string> = {};
  const agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }> = {};
  const projects: Record<number, { name: string; color: string }> = {};
  for (const a of agentList) {
    folderNames[a.id] = a.folderName;
    projects[a.id] = { name: a.projectName, color: a.projectColor };
    if (persistedSeats?.[a.id]) {
      const s = persistedSeats[a.id];
      agentMeta[a.id] = { palette: s.palette, hueShift: s.hueShift, seatId: s.seatId ?? undefined };
    }
  }
  ws.send(JSON.stringify({ type: "existingAgents", agents: agentIds, folderNames, agentMeta, projects }));

  // Send layout (must come after existingAgents — the hook buffers agents until layout arrives)
  if (currentLayout) {
    ws.send(JSON.stringify({ type: "layoutLoaded", layout: currentLayout, version: 1 }));
  } else {
    // Send null layout to trigger default layout creation in the UI
    ws.send(JSON.stringify({ type: "layoutLoaded", layout: null, version: 0 }));
  }

  // Replay live state AFTER layout — characters only exist once the layout is
  // applied, so these would no-op if sent any earlier. (Claude JSONL tool
  // activity still isn't replayed — the parser keeps no snapshot — but opencode
  // activity is tracked in ocToolState, so we can restore it for fresh clients.)
  for (const [key, a] of agents) {
    if (a.needsInput) ws.send(JSON.stringify({ type: "agentToolPermission", id: a.id }));
    const tool = ocToolState.get(key);
    if (tool) {
      ws.send(JSON.stringify({ type: "agentStatus", id: a.id, status: "active" }));
      ws.send(JSON.stringify({ type: "agentToolStart", id: a.id, toolId: `oc:tool:${key}`, status: tool }));
    }
  }
}

wss.on("connection", (ws) => {
  (ws as unknown as Record<string, boolean>).__isAlive = true;
  ws.on("pong", () => { (ws as unknown as Record<string, boolean>).__isAlive = true; });
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
          currentLayout = msg.layout as Record<string, unknown>;
          // Broadcast to other clients for multi-tab sync
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
      /* ignore invalid messages */
    }
  });

  ws.on("close", () => clients.delete(ws));
});

// Watcher — drives the office straight from AgentsRoom's on-disk data.
const watcher = new AgentsRoomWatcher();

const ROLE_LABEL: Record<string, string> = {
  fullstack: "Full-Stack",
  frontend: "Frontend",
  backend: "Backend",
  qa: "QA",
  architect: "Architect",
  brainstormer: "Brainstormer",
  devops: "DevOps",
};

const LABEL_MAX = 34;

function labelFor(a: RoomAgent): string {
  const role = ROLE_LABEL[a.role] ?? a.role;
  const task = a.title.trim();
  const full = task ? `${role}: ${task}` : role;
  return full.length > LABEL_MAX ? full.slice(0, LABEL_MAX - 1).trimEnd() + "…" : full;
}

function numericId(key: string): number {
  let id = idByKey.get(key);
  if (id === undefined) {
    id = nextAgentId++;
    idByKey.set(key, id);
  }
  return id;
}

// Wire (or rewire) a Claude Code JSONL session to a character so its live tool
// activity animates the right agent. Empty sessionId = agent has no live session.
function linkSession(id: number, sessionId: string): void {
  if (sessionId) sessionToId.set(sessionId, id);
}

// Drive typing/reading animation for sources that poll their own activity
// (opencode). No-op for AgentsRoom agents (Claude activity comes from the JSONL
// parser, which leaves toolStatus undefined). Runs BEFORE the needs-input bubble
// so agentToolsClear (which also clears bubbles) can't clobber it.
function applyLiveActivity(id: number, key: string, a: RoomAgent): void {
  if (a.toolStatus === undefined) return;
  const prevTool = ocToolState.get(key) ?? null;
  const nextTool = a.active ? a.toolStatus ?? null : null;
  if (nextTool === prevTool) return;
  if (nextTool !== null) {
    broadcast({ type: "agentStatus", id, status: "active" });
    broadcast({ type: "agentToolsClear", id });
    broadcast({ type: "agentToolStart", id, toolId: `oc:tool:${key}`, status: nextTool });
  } else {
    broadcast({ type: "agentToolsClear", id });
    broadcast({ type: "agentStatus", id, status: "idle" });
  }
  ocToolState.set(key, nextTool);
}

// Shared handlers — both AgentsRoom and opencode emit the same RoomAgent shape,
// so they feed the exact same lifecycle (label, project color, zones, needs-input).
function onAgentJoined(a: RoomAgent): void {
  lastActivityTime = Date.now();
  const id = numericId(a.key);
  const folderName = labelFor(a);
  agents.set(a.key, { id, folderName, needsInput: a.needsInput, claudeSessionId: a.claudeSessionId, projectName: a.projectName, projectColor: a.projectColor });
  linkSession(id, a.claudeSessionId);
  broadcast({ type: "agentCreated", id, folderName, projectName: a.projectName, projectColor: a.projectColor });
  applyLiveActivity(id, a.key, a);
  if (a.needsInput) broadcast({ type: "agentToolPermission", id });
  console.log(`Agent ${id} joined: ${folderName}`);
}

function onAgentChanged(a: RoomAgent): void {
  lastActivityTime = Date.now();
  const id = numericId(a.key);
  const folderName = labelFor(a);
  const prev = agents.get(a.key);
  const respawned = prev !== undefined && prev.folderName !== folderName;
  // ponytail: the UI fixes a character's label at spawn — respawn to refresh
  // the visible task. The 0.3s effect doubles as a "new task" signal. Seat is
  // stable because the numeric id (and its persisted seat) is reused.
  if (respawned) {
    broadcast({ type: "agentClosed", id });
    broadcast({ type: "agentCreated", id, folderName, projectName: a.projectName, projectColor: a.projectColor });
    ocToolState.delete(a.key); // force activity to re-emit onto the fresh character
  }
  applyLiveActivity(id, a.key, a);
  // Only touch the needs-input bubble when it actually changes (or after a
  // respawn cleared it). Runs AFTER applyLiveActivity so the bubble survives.
  if (respawned || prev?.needsInput !== a.needsInput) {
    broadcast(a.needsInput ? { type: "agentToolPermission", id } : { type: "agentToolPermissionClear", id });
  }
  agents.set(a.key, { id, folderName, needsInput: a.needsInput, claudeSessionId: a.claudeSessionId, projectName: a.projectName, projectColor: a.projectColor });
  linkSession(id, a.claudeSessionId);
}

function onAgentLeft(key: string): void {
  const rec = agents.get(key);
  if (!rec) return;
  agents.delete(key);
  ocToolState.delete(key);
  if (rec.claudeSessionId) {
    sessionToId.delete(rec.claudeSessionId);
    parserState.delete(rec.claudeSessionId);
  }
  broadcast({ type: "agentClosed", id: rec.id });
  console.log(`Agent ${rec.id} left`);
}

watcher.on("agentJoined", onAgentJoined);
watcher.on("agentChanged", onAgentChanged);
watcher.on("agentLeft", onAgentLeft);

// opencode watcher — surfaces opencode sessions (e.g. deepseek agents) from its
// SQLite store as characters too, grouped into the same project zones.
const opencode = new OpencodeWatcher();
opencode.on("agentJoined", onAgentJoined);
opencode.on("agentChanged", onAgentChanged);
opencode.on("agentLeft", onAgentLeft);

// JSONL watcher — drives live tool animations (typing/reading) for agents that
// have a Claude Code session. Lifecycle/labels stay owned by AgentsRoom, so we
// ignore fileAdded/fileRemoved and only forward streamed lines to the parser.
const jsonl = new JsonlWatcher();

jsonl.on("line", (file: WatchedFile, line: string) => {
  const id = sessionToId.get(file.sessionId);
  if (id === undefined) return; // not an agent AgentsRoom tracks — ignore
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
      activeTools: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastActivityTime: Date.now(),
    };
    parserState.set(file.sessionId, state);
  }
  lastActivityTime = Date.now();
  processTranscriptLine(line, state, broadcast);
});

// Start
watcher.start();
jsonl.start();
opencode.start();
server.listen(PORT, () => {
  console.log(`Pixel Agents server running at http://localhost:${PORT}`);
  console.log(`Watching ~/.agentsroom + ~/.claude/projects + opencode.db...`);
});

// Idle shutdown
setInterval(() => {
  if (agents.size === 0 && clients.size === 0 && Date.now() - lastActivityTime > IDLE_SHUTDOWN_MS) {
    console.log("No active sessions or clients for 10 minutes, shutting down...");
    watcher.stop();
    jsonl.stop();
    opencode.stop();
    server.close();
    process.exit(0);
  }
}, 30_000);

// Graceful shutdown
process.on("SIGINT", () => {
  watcher.stop();
  server.close();
  process.exit(0);
});
