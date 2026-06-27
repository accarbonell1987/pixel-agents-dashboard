import { execFile } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { EventEmitter } from "events";
import type { RoomAgent } from "./agentsRoomWatcher.js";

// opencode keeps its sessions in a SQLite DB. We read it (read-only) via the
// `sqlite3` CLI — no native dependency, no flags — and surface top-level
// sessions that were active recently as agents, mapping their working
// directory to an AgentsRoom project for color/zone grouping.
const DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db");
const CONFIG_PATH = join(homedir(), ".agentsroom", "config.json");
const POLL_INTERVAL_MS = 3000;
const ACTIVE_WINDOW_MIN = 30; // a session updated within N min counts as "running"

interface OcSession {
  id: string;
  parent_id: string | null;
  directory: string;
  title: string;
  agent: string;
  provider: string | null;
  model_id: string | null;
  // Latest message-part of the session — tells us what it's doing right now.
  ptype: string | null;
  tool: string | null;
  status: string | null; // running | pending | completed | error
  filePath: string | null;
  command: string | null;
}

// Include sub-sessions (parent_id set) — those are an agent's sub-agents.
// Left-join the session's most recent part to read live activity + pending approvals.
const QUERY = `
  with active as (
    select id, parent_id, directory, title, agent,
           json_extract(model,'$.providerID') as provider,
           json_extract(model,'$.id') as model_id
    from session
    where time_archived is null
      and time_updated > (strftime('%s','now')*1000 - ${ACTIVE_WINDOW_MIN}*60*1000)
  )
  select a.*,
         json_extract(p.data,'$.type') as ptype,
         json_extract(p.data,'$.tool') as tool,
         json_extract(p.data,'$.state.status') as status,
         json_extract(p.data,'$.state.input.filePath') as filePath,
         json_extract(p.data,'$.state.input.command') as command
  from active a
  left join part p on p.id = (
    select id from part where session_id = a.id order by time_created desc limit 1
  );`;

const BASH_MAX = 30;

function base(filePath: string | null): string {
  return filePath ? basename(filePath) : "";
}

// Format an opencode tool into a status string whose PREFIX the UI maps to the
// right animation (see webview toolUtils.STATUS_TO_TOOL): Reading/Editing/etc.
function formatTool(tool: string | null, filePath: string | null, command: string | null): string {
  switch ((tool ?? "").toLowerCase()) {
    case "read":
      return `Reading ${base(filePath)}`;
    case "edit":
    case "patch":
      return `Editing ${base(filePath)}`;
    case "write":
      return `Writing ${base(filePath)}`;
    case "bash": {
      const cmd = command ?? "";
      return `Running: ${cmd.length > BASH_MAX ? cmd.slice(0, BASH_MAX) + "…" : cmd}`;
    }
    case "grep":
      return "Searching code";
    case "glob":
    case "list":
      return "Globbing files";
    case "webfetch":
      return "Fetching web content";
    case "websearch":
      return "Searching the web";
    case "task":
      return "Task: subtask";
    default:
      return `Using ${tool ?? "tool"}`;
  }
}

function readProjectMap(): Array<{ name: string; directoryPath: string; color: string }> {
  if (!existsSync(CONFIG_PATH)) return [];
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return (config?.projects ?? []).map((p: any) => ({
      name: p.name,
      directoryPath: p.directoryPath,
      color: p.colorHex ?? "#888888",
    }));
  } catch {
    return [];
  }
}

function signature(a: RoomAgent): string {
  return `${a.role}|${a.title}|${a.projectName}|${a.needsInput}|${a.active}|${a.toolStatus}`;
}

export class OpencodeWatcher extends EventEmitter {
  private agents = new Map<string, RoomAgent>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private warned = false;

  start(): void {
    if (!existsSync(DB_PATH)) return; // opencode not installed — nothing to do
    this.scan();
    this.timer = setInterval(() => this.scan(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private scan(): void {
    execFile(
      "sqlite3",
      ["-json", `file:${DB_PATH}?mode=ro`, QUERY],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          if (!this.warned) {
            console.warn(`[opencode] cannot read sessions: ${err.message}`);
            this.warned = true;
          }
          return;
        }
        let rows: OcSession[];
        try {
          rows = stdout.trim() ? JSON.parse(stdout) : [];
        } catch {
          return; // mid-write — next poll catches it
        }
        this.diff(rows);
      },
    );
  }

  private diff(rows: OcSession[]): void {
    const projects = readProjectMap();
    const seen = new Set<string>();

    for (const row of rows) {
      const key = `oc:${row.id}`;
      const proj = projects.find((p) => p.directoryPath && row.directory.startsWith(p.directoryPath));
      const provider = row.provider ?? "opencode";
      // Sub-sessions render with a "↳" marker; top-level keep the provider tag.
      const role = row.parent_id ? `↳ ${row.agent}` : `${provider} · ${row.agent}`;

      // Derive live state from the latest part:
      //  running tool -> active + typing/reading; pending tool -> needs approval.
      const isTool = row.ptype === "tool";
      const running = isTool && row.status === "running";
      const pending = isTool && row.status === "pending";

      const next: RoomAgent = {
        key,
        projectName: proj?.name ?? basename(row.directory),
        projectColor: proj?.color ?? "#6E7681",
        role,
        model: row.model_id ?? "",
        title: row.title ?? "",
        type: "",
        needsInput: pending,
        claudeSessionId: "", // no Claude JSONL — activity driven below, not by parser
        active: running,
        toolStatus: running ? formatTool(row.tool, row.filePath, row.command) : null,
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

    for (const key of [...this.agents.keys()]) {
      if (!seen.has(key)) {
        this.agents.delete(key);
        this.emit("agentLeft", key);
      }
    }
  }
}
