import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { EventEmitter } from "events";

// AgentsRoom stores everything as plain JSON on disk — we just read it.
// Global project registry:
const CONFIG_PATH = join(homedir(), ".agentsroom", "config.json");
const POLL_INTERVAL_MS = 1500;

// One AI agent as seen across AgentsRoom (project roster + live status file).
export interface RoomAgent {
  key: string; // agentId, unique across all projects
  projectName: string;
  role: string;
  model: string;
  title: string; // current task ("" if no live session yet)
  type: string; // feature | bug | refactor | ...
  needsInput: boolean;
  claudeSessionId: string; // links to ~/.claude/projects/**/<id>.jsonl ("" if none)
  projectColor: string; // config.json colorHex — groups agents by project
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null; // half-written file mid-flush — next poll catches it
  }
}

function signature(a: RoomAgent): string {
  return `${a.role}|${a.title}|${a.needsInput}|${a.projectName}|${a.claudeSessionId}`;
}

export class AgentsRoomWatcher extends EventEmitter {
  private agents = new Map<string, RoomAgent>();
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.scan();
    this.timer = setInterval(() => this.scan(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private scan(): void {
    const config = readJson(CONFIG_PATH);
    const projects: Array<{ name: string; directoryPath: string; colorHex?: string }> =
      config?.projects ?? [];

    const seen = new Set<string>();

    for (const proj of projects) {
      const roomDir = join(proj.directoryPath, ".agentsroom");
      const roster = readJson(join(roomDir, "agents-cache.json"))?.data ?? [];

      for (const entry of roster as Array<{
        id: string;
        role?: string;
        model?: string;
        claudeSessionId?: string;
      }>) {
        const key = entry.id;
        const status = readJson(join(roomDir, "sessions", `${key}.json`));

        const next: RoomAgent = {
          key,
          projectName: proj.name,
          role: entry.role ?? "agent",
          model: entry.model ?? "",
          title: status?.title ?? "",
          type: status?.type ?? "",
          needsInput: status?.needsInput === true,
          claudeSessionId: entry.claudeSessionId ?? "",
          projectColor: proj.colorHex ?? "#888888",
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

    // Agents that disappeared from every roster have left.
    for (const key of [...this.agents.keys()]) {
      if (!seen.has(key)) {
        this.agents.delete(key);
        this.emit("agentLeft", key);
      }
    }
  }
}
