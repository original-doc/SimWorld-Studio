"use strict";

const { spawn } = require("child_process");
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { SkillRegistry } = require("./skills");
const { SceneManager } = require("./scenes");
const { ArenaManager } = require("./arena");
const { AgentManager } = require("./agents");

const PORT = parseInt(process.env.PORT || "3002", 10);
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const MCP_CONFIG = path.resolve(__dirname, "../mcp.json");
const ARENA_ROOT = path.resolve(__dirname, "../..");
const SCREENSHOT_DIR = path.join(ARENA_ROOT, "tmp", "screens");
const LOG_DIR = path.join(ARENA_ROOT, "logs");
const PIXEL_STREAMING_URL = process.env.PIXEL_STREAMING_URL || "http://127.0.0.1:8080";
const UNREAL_HOST = process.env.UNREAL_HOST || "127.0.0.1";
const UNREAL_PORT = process.env.UNREAL_PORT || "55559";

const skillRegistry = new SkillRegistry();
const sceneManager = new SceneManager();
const arenaManager = new ArenaManager();
const agentManager = new AgentManager();

const SCREENSHOT_SEARCH_DIRS = [SCREENSHOT_DIR];
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════
// FIX 1: Session result cache — survives browser disconnect
// ═══════════════════════════════════════════════════════════════════════
let lastSessionResult = null;
const activeSessions = new Map(); // sessionId -> { status, result, startedAt }

function getLogFilePath() {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `chat_${d}.log`);
}

function logToFile(tag, msg) {
  const line = `[${new Date().toISOString()}] [${tag}] ${msg}\n`;
  try { fs.appendFileSync(getLogFilePath(), line); } catch {}
  console.log(`[${tag}] ${msg}`);
}

const ARENA_SYSTEM_PROMPT = `You are the SimWorld Studio scene-generation agent.
You build city scenes in Unreal Engine 5 using MCP tools. The user sees a live viewport on the right.

## CRITICAL: HOW TO SPAWN OBJECTS

SimWorld assets are Blueprint actors. You MUST use spawn_blueprint_actor (NOT spawn_actor) for buildings, trees, vehicles, and props.

### Buildings (6 varieties — ONLY these exist in this package)
spawn_blueprint_actor with blueprint_id: BP_Building_01 through BP_Building_06 ONLY.
Full path format: /Game/CityDatabase/blueprints/BP_Building_XX.BP_Building_XX_C

IMPORTANT: ONLY use BP_Building_01 through BP_Building_06. Do NOT use any building ID above 06 — those assets are not available and will appear as invisible/broken.
- BP_Building_01: small residential
- BP_Building_02: small residential
- BP_Building_03: small residential
- BP_Building_04: medium building
- BP_Building_05: medium building
- BP_Building_06: medium building

Example — spawn a house:
  spawn_blueprint_actor(actor_name="House_1", blueprint_id="BP_Building_05", location=[0, 0, 0])

### Trees (6 varieties)
  spawn_blueprint_actor(actor_name="Tree_1", blueprint_id="BP_Tree1", location=[500, 200, 0])
  BP_Tree1 through BP_Tree6

### Street furniture (ONLY these are available)
  BP_Hydrant, BP_Trash_bin_a, BP_Trash_bin_b, BP_Trash_can, BP_Table, BP_Table2, BP_Table3
  BP_RoadBlocker, BP_RoadCone, BP_Couch
  Do NOT use: BP_Box, BP_Box2, BP_Box3, BP_Can, BP_Can2, BP_Rabbish, BP_Soda1, BP_Soda2 (meshes missing)

### Vehicles
  BP_Scooter_01 through BP_Scooter_04, BP_Cart, BP_Cart2

### Roads (static mesh — use spawn_actor)
  spawn_actor(name="Road_1", static_mesh="/Game/CityDatabase/meshes/SM_Road.SM_Road", location=[0,0,0], scale=[10,10,1])

## UNITS & SPACING
- UE uses centimeters: 1 meter = 100 units
- Small buildings (01-03): ~1000-3000 units tall, ~1000-2000 wide. Space 3000-5000 apart.
- Medium buildings (04-06): ~3000-6000 units tall. Space 5000-8000 apart.
- Trees: 1000-2000 units apart
- A small residential block: roughly 15000x10000 units

## WORKFLOW — FOLLOW THIS EXACTLY
1. Call delete_all_spawned() FIRST to clear previous session objects
2. Call setup_environment() to create sun, sky, fog, ground. Without it the scene is BLACK.
3. Plan the layout: calculate positions for all objects before spawning
4. Spawn buildings using spawn_blueprint_actor with varied blueprint_ids
5. Add trees along streets
6. Add street furniture (hydrants, trash bins, etc.)
7. Take a screenshot with take_screenshot() so the user sees results
8. Tell the user what you built

## EXAMPLE: "Build 6 houses with trees"
1. delete_all_spawned()
2. setup_environment()
3. Spawn 6 buildings (01-06 only!) in a 2x3 grid, 4000 units apart:
   spawn_blueprint_actor(actor_name="House_1", blueprint_id="BP_Building_01", location=[0, 0, 0])
   spawn_blueprint_actor(actor_name="House_2", blueprint_id="BP_Building_03", location=[4000, 0, 0])
   spawn_blueprint_actor(actor_name="House_3", blueprint_id="BP_Building_05", location=[8000, 0, 0])
   spawn_blueprint_actor(actor_name="House_4", blueprint_id="BP_Building_02", location=[0, 5000, 0])
   spawn_blueprint_actor(actor_name="House_5", blueprint_id="BP_Building_06", location=[4000, 5000, 0])
   spawn_blueprint_actor(actor_name="House_6", blueprint_id="BP_Building_04", location=[8000, 5000, 0])
4. Add trees between houses:
   spawn_blueprint_actor(actor_name="Tree_1", blueprint_id="BP_Tree1", location=[2000, -800, 0])
   spawn_blueprint_actor(actor_name="Tree_2", blueprint_id="BP_Tree3", location=[6000, -800, 0])
   ... (more trees along the streets)
5. take_screenshot()

## IMPORTANT RULES
- ALWAYS use spawn_blueprint_actor for buildings/trees/props, NOT spawn_actor
- Each actor_name must be unique
- Use varied blueprint_ids (don't use the same building for everything)
- After placing objects, ALWAYS take_screenshot so the user sees results
- DO NOT set or move the camera. DO NOT use execute_python_script to change camera position/rotation. The camera is controlled by the user via the viewport. Just call take_screenshot directly.
- Keep it simple: spawn objects, screenshot. Don't overthink it.`;

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use("/screenshots", express.static(SCREENSHOT_DIR));
app.use("/thumbnails", express.static(path.join(ARENA_ROOT, "tmp", "thumbnails")));

// ── UE pixel streaming page ──
app.get("/ue", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html style="width:100%;height:100%;margin:0;background:#000">
<head><meta charset="utf-8"><title>UE Pixel Stream</title>
<style>body{margin:0;width:100vw;height:100vh;background:#000;overflow:hidden}</style>
<script>
(function(){var p=new URLSearchParams(location.search);
if(!p.has('ss')){p.set('ss','ws://'+location.hostname+':8080');
location.replace(location.pathname+'?'+p.toString());}})();
</script>
<script defer src="/ue-assets/player.js"></script>
</head><body style="width:100vw;height:100vh"></body></html>`);
});

app.get("/api/pixel-streaming-url", (req, res) => {
  const host = req.headers.host?.split(":")[0] || "127.0.0.1";
  res.json({ url: `http://${host}:8080` });
});

// ═══════════════════════════════════════════════════════════════════════
// FIX 2: Session recovery endpoints
// ═══════════════════════════════════════════════════════════════════════
app.get("/api/session/latest", (req, res) => {
  if (!lastSessionResult) return res.status(404).json({ error: "No session yet" });
  res.json(lastSessionResult);
});

app.get("/api/session/active", (req, res) => {
  const active = [];
  for (const [id, info] of activeSessions) {
    active.push({ sessionId: id, status: info.status, startedAt: info.startedAt });
  }
  res.json({ active, lastResult: lastSessionResult ? {
    sessionId: lastSessionResult.sessionId,
    timestamp: lastSessionResult.timestamp,
    latestScreenshot: lastSessionResult.latestScreenshot
  } : null });
});

// ── Health ──
app.get("/api/health", (req, res) => {
  const net = require("net");
  let ueUp = false;
  const sock = new net.Socket();
  const timer = setTimeout(() => { sock.destroy(); done(); }, 2000);
  sock.connect(parseInt(UNREAL_PORT), UNREAL_HOST, () => {
    ueUp = true; sock.destroy(); clearTimeout(timer); done();
  });
  sock.on("error", () => { clearTimeout(timer); done(); });
  function done() {
    res.json({
      status: "ok",
      ueConnected: ueUp,
      mcpConnected: ueUp,
      pixelStreamingUrl: PIXEL_STREAMING_URL,
      activeGenerations: activeSessions.size,
      lastSessionAt: lastSessionResult?.timestamp || null
    });
  }
});

// ── Screenshot endpoints ──
app.get("/api/screenshot/latest", (req, res) => {
  let best = null;
  for (const dir of SCREENSHOT_SEARCH_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir)
        .filter(f => f.endsWith(".png"))
        .map(f => ({ filepath: path.join(dir, f), time: fs.statSync(path.join(dir, f)).mtimeMs }))
        .filter(({ time }) => Date.now() - time < 1800000);
      for (const e of entries) {
        if (!best || e.time > best.time) best = e;
      }
    } catch {}
  }
  if (!best) return res.status(404).json({ error: "No screenshots found" });
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(best.filepath);
});

app.get("/api/screenshot/file", (req, res) => {
  const fp = req.query.path;
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "Not found" });
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.resolve(fp));
});

// ── Camera ──
app.post("/api/camera", (req, res) => {
  const { cmd, args = [] } = req.body;
  if (!["set_camera", "get_camera"].includes(cmd))
    return res.status(400).json({ error: "Unknown camera command" });
  const net = require("net");
  const sock = new net.Socket();
  const timer = setTimeout(() => { sock.destroy(); res.status(504).json({ error: "Timeout" }); }, 10000);
  let params = {};
  if (cmd === "set_camera" && args.length >= 6) {
    params = { script: `
import unreal
subsys = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)
loc = unreal.Vector(${args[0]}, ${args[1]}, ${args[2]})
rot = unreal.Rotator(${args[3]}, ${args[4]}, ${args[5]})
subsys.set_level_viewport_camera_info(loc, rot)
` };
    sock.connect(parseInt(UNREAL_PORT), UNREAL_HOST, () => {
      sock.write(JSON.stringify({ type: "execute_python_script", params }) + "\n");
    });
  } else {
    clearTimeout(timer);
    return res.json({ ok: true, result: "no-op" });
  }
  let buf = "";
  sock.on("data", d => {
    buf += d.toString();
    try {
      const parsed = JSON.parse(buf);
      clearTimeout(timer); sock.destroy();
      res.json({ ok: true, result: parsed });
    } catch {}
  });
  sock.on("error", e => { clearTimeout(timer); res.status(500).json({ error: e.message }); });
});

// ── Skills CRUD ──
app.get("/api/skills", (req, res) => res.json(skillRegistry.list()));

app.get("/api/skills/:id", (req, res) => {
  const s = skillRegistry.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Skill not found" });
  res.json(s);
});

app.get("/api/skills/search/:query", (req, res) => {
  res.json(skillRegistry.search(req.params.query));
});

app.post("/api/skills/reload", (req, res) => {
  skillRegistry.reload();
  res.json({ ok: true, count: skillRegistry.list().length });
});

app.post("/api/skills", (req, res) => {
  const { id, name, description, tags, dependencies, content } = req.body;
  if (!id || !name || !content)
    return res.status(400).json({ error: "id, name, and content are required" });
  const frontmatter = [
    "---", `id: ${id}`, `name: ${name}`, "version: 1.0.0", "author: custom",
    `tags: [${(tags || []).join(", ")}]`,
    `dependencies: [${(dependencies || []).join(", ")}]`,
    `description: ${description || name}`, "---", "", content
  ].join("\n");
  const skillsDir = path.resolve(__dirname, "../../skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, `${id}.md`), frontmatter, "utf-8");
  skillRegistry.reload();
  const result = skillRegistry.get(id);
  res.json(result || { id, name, description, tags, source: "custom" });
});

app.delete("/api/skills/:id", (req, res) => {
  const s = skillRegistry.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Skill not found" });
  if (s.source !== "custom") return res.status(400).json({ error: "Cannot delete builtin skills" });
  if (fs.existsSync(s.filePath)) fs.unlinkSync(s.filePath);
  skillRegistry.reload();
  res.json({ ok: true });
});

// ── Scenes CRUD ──
app.get("/api/scenes", (req, res) => res.json(sceneManager.list()));
app.get("/api/scenes/:id", (req, res) => {
  const s = sceneManager.load(req.params.id);
  if (!s) return res.status(404).json({ error: "Scene not found" });
  res.json(s);
});
app.post("/api/scenes", (req, res) => res.json(sceneManager.save(req.body)));
app.delete("/api/scenes/:id", (req, res) => res.json({ ok: sceneManager.delete(req.params.id) }));
app.get("/api/scenes/:id/thumbnail", (req, res) => {
  const tp = sceneManager.getThumbnailPath(req.params.id);
  if (!tp) return res.status(404).json({ error: "No thumbnail" });
  res.sendFile(tp);
});

// ── Arena: battles, leaderboard, gallery ──
app.post("/api/arena/battles", (req, res) => {
  const { prompt, skills } = req.body;
  res.json(arenaManager.createBattle(prompt, skills));
});

app.get("/api/arena/battles", (req, res) => {
  const { status, limit, offset } = req.query;
  res.json(arenaManager.listBattles({
    status, limit: Number(limit) || 50, offset: Number(offset) || 0
  }));
});

app.get("/api/arena/battles/:id", (req, res) => {
  const b = arenaManager.getBattle(req.params.id);
  if (!b) return res.status(404).json({ error: "Battle not found" });
  res.json(b);
});

app.post("/api/arena/battles/:id/submit", (req, res) => {
  const { side, sceneData } = req.body;
  const result = arenaManager.submitSceneForBattle(req.params.id, side, sceneData);
  if (!result) return res.status(404).json({ error: "Battle not found" });
  res.json(result);
});

app.post("/api/arena/battles/:id/vote", (req, res) => {
  const { winner } = req.body;
  const result = arenaManager.vote(req.params.id, winner);
  if (!result) return res.status(404).json({ error: "Battle not found" });
  res.json(result);
});

app.get("/api/arena/leaderboard", (req, res) => res.json(arenaManager.getLeaderboard()));

app.get("/api/arena/gallery", (req, res) => {
  const { limit, offset, sort } = req.query;
  res.json(arenaManager.listGallery({
    limit: Number(limit) || 50, offset: Number(offset) || 0, sort
  }));
});

app.post("/api/arena/gallery", (req, res) => res.json(arenaManager.addToGallery(req.body)));

app.get("/api/arena/gallery/:id", (req, res) => {
  const s = arenaManager.getGalleryScene(req.params.id);
  if (!s) return res.status(404).json({ error: "Scene not found" });
  res.json(s);
});

// ── Agents ──
app.get("/api/agents", (req, res) => res.json(agentManager.list()));

app.post("/api/agents", (req, res) => res.json(agentManager.register(req.body)));

app.patch("/api/agents/:id", (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled === "boolean") {
    const a = agentManager.toggleEnabled(req.params.id, enabled);
    return a ? res.json(a) : res.status(404).json({ error: "Agent not found" });
  }
  res.json(agentManager.register({ id: req.params.id, ...req.body }));
});

// ── Arena battle run (SSE) ──
app.post("/api/arena/battles/:id/run", async (req, res) => {
  const battle = arenaManager.getBattle(req.params.id);
  if (!battle) return res.status(404).json({ error: "Battle not found" });
  if (battle.status === "voted") return res.status(400).json({ error: "Battle already completed" });

  // FIX: SSE headers for Cloudflare tunnel compatibility
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  function send(event, data) {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    const result = await agentManager.runBattle(
      battle.prompt, battle.skills, ARENA_SYSTEM_PROMPT,
      (phase, info) => send("progress", { phase, ...info })
    );
    arenaManager.submitSceneForBattle(battle.id, "a", result.side_a);
    arenaManager.submitSceneForBattle(battle.id, "b", result.side_b);
    send("complete", arenaManager.getBattle(battle.id));
  } catch (e) {
    send("error", { message: e.message });
  }
  res.end();
});

// ── Arena combined run (SSE) ──
app.post("/api/arena/run", async (req, res) => {
  const { prompt, skills } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  const battle = arenaManager.createBattle(prompt, skills || []);

  // FIX: SSE headers for Cloudflare tunnel compatibility
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  function send(event, data) {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  send("battle_created", { battleId: battle.id, prompt });

  try {
    const result = await agentManager.runBattle(
      prompt, skills || [], ARENA_SYSTEM_PROMPT,
      (phase, info) => send("progress", { phase, ...info })
    );
    arenaManager.submitSceneForBattle(battle.id, "a", result.side_a);
    arenaManager.submitSceneForBattle(battle.id, "b", result.side_b);
    send("complete", arenaManager.getBattle(battle.id));
  } catch (e) {
    send("error", { message: e.message });
  }
  res.end();
});

// ── Assets ──
app.get("/api/assets", (req, res) => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "assets.json"), "utf-8"));
    const result = {};
    for (const [cat, info] of Object.entries(raw)) {
      const entry = { description: info.description || "", items: [] };
      if (cat === "buildings" && info.ids) {
        entry.items = info.ids.map(id => {
          const name = `BP_Building_${String(id).padStart(2, "0")}`;
          return { id: name, path: `/Game/CityDatabase/blueprints/${name}.${name}_C` };
        });
        if (info.notes) entry.description += " " + info.notes;
      } else if (info.items) {
        entry.items = info.items.map(item => {
          if (typeof item === "string") {
            const parts = item.split("/");
            return { id: parts[parts.length - 1].split(".")[0], path: item };
          }
          return item;
        });
      }
      result[cat] = entry;
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// /api/chat — Main chat endpoint with ALL tunnel-resilience fixes
// ═══════════════════════════════════════════════════════════════════════
app.post("/api/chat", (req, res) => {
  const { message, sessionId, skills, feedback } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  // FIX 3: SSE headers — add no-transform to prevent Cloudflare buffering
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  function send(event, data) {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // FIX 4: Aggressive keepalive — 8s with data payload to defeat proxy timeouts
  const keepalive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(`event: ping\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);
    }
  }, 8000);

  // Build system prompt with skills
  let systemPrompt = ARENA_SYSTEM_PROMPT;
  if (skills && skills.length > 0) {
    const composed = skillRegistry.compose(skills);
    if (composed) systemPrompt += "\n\n## ACTIVE SKILLS (reference documentation)\n" + composed;
  }
  if (feedback) {
    systemPrompt += `\n\n## USER FEEDBACK ON CURRENT SCENE
The user is providing feedback on the current scene. Modify the scene based on this feedback. Do NOT start from scratch — refine what exists.
Feedback: ${feedback}`;
  }

  // Build Claude CLI args
  const args = [
    "-p", message,
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--dangerously-skip-permissions",
    "--mcp-config", MCP_CONFIG,
    "--append-system-prompt", systemPrompt
  ];
  if (sessionId) args.push("--resume", sessionId);

  // Clean env for Claude subprocess
  const env = Object.assign({}, process.env);
  delete env.CLAUDECODE;
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  logToFile("chat", `User: "${message.slice(0, 200)}" sessionId=${sessionId || "new"}`);
  try { fs.writeFileSync(path.join(LOG_DIR, "raw_latest.jsonl"), ""); } catch {}

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: path.resolve(__dirname, ".."),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let buffer = "";
  let seenToolIds = new Set();
  let currentSessionId = sessionId || null;
  let latestScreenshotPath = null;
  let browserDisconnected = false;

  // Track this as an active session
  const trackingId = sessionId || `pending_${Date.now()}`;
  activeSessions.set(trackingId, { status: "running", startedAt: Date.now() });

  function processLine(line) {
    line = line.trim();
    if (!line) return;
    try { fs.appendFileSync(path.join(LOG_DIR, "raw_latest.jsonl"), line + "\n"); } catch {}

    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    const type = msg.type;

    if (type === "system" && msg.subtype === "init") {
      if (msg.session_id) {
        currentSessionId = msg.session_id;
        // Update tracking key
        activeSessions.delete(trackingId);
        activeSessions.set(currentSessionId, { status: "running", startedAt: Date.now() });
      }
      const servers = (msg.mcp_servers || []).map(s => `${s.name}:${s.status}`);
      send("system", { sessionId: msg.session_id, mcpServers: msg.mcp_servers || [] });
      logToFile("claude", `Session ${msg.session_id} | MCP: ${servers.join(", ")}`);
    }
    else if (type === "stream_event") {
      const ev = msg.event || {};
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        send("text", { delta: ev.delta.text });
      }
      if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        const block = ev.content_block;
        if (!seenToolIds.has(block.id)) {
          seenToolIds.add(block.id);
          const displayName = block.name.replace(/^mcp__\w+__/, "");
          send("tool_start", { id: block.id, name: block.name, displayName });
          logToFile("tool", `Starting: ${block.name}`);
        }
      }
      if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
        send("tool_input", { delta: ev.delta.partial_json });
      }
    }
    else if (type === "assistant") {
      const content = msg.message?.content || [];
      for (const block of content) {
        if (block.type === "tool_use") {
          const displayName = block.name.replace(/^mcp__\w+__/, "");
          send("tool_details", { id: block.id, name: block.name, displayName, input: block.input });
        }
      }
    }
    else if (type === "user") {
      const content = msg.message?.content || [];
      for (const block of content) {
        if (block.type === "tool_result") {
          const text = Array.isArray(block.content)
            ? block.content.map(c => c.text || "").join("")
            : String(block.content || "");
          const pngMatch = text.match(/([\/][\w\/\-._]+\.png)/);
          if (pngMatch && fs.existsSync(pngMatch[1])) {
            latestScreenshotPath = pngMatch[1];
            send("screenshot", {
              toolUseId: block.tool_use_id,
              filepath: `/api/screenshot/file?path=${encodeURIComponent(latestScreenshotPath)}`
            });
          }
          send("tool_result", {
            toolUseId: block.tool_use_id,
            result: text.slice(0, 2000),
            isError: block.is_error || false
          });
          logToFile("tool_result", `${block.tool_use_id?.slice(0, 8)} → ${text.slice(0, 300)}`);
        }
      }
    }
    else if (type === "result") {
      currentSessionId = msg.session_id;
      const isError = msg.is_error || msg.subtype === "error_during_turn";
      logToFile("claude", `Result: subtype=${msg.subtype} session=${currentSessionId} cost=$${msg.total_cost_usd || "?"}`);
      logToFile("result", JSON.stringify({
        subtype: msg.subtype, cost: msg.total_cost_usd, duration: msg.duration_ms
      }).slice(0, 500));

      findLatestScreenshot();
      clearInterval(keepalive);

      const screenshotUrl = latestScreenshotPath
        ? `/api/screenshot/file?path=${encodeURIComponent(latestScreenshotPath)}`
        : findLatestScreenshotUrl();

      const donePayload = {
        sessionId: currentSessionId,
        isError,
        costUsd: msg.total_cost_usd,
        latestScreenshot: screenshotUrl
      };

      // FIX 5: Always cache result — browser may have disconnected
      lastSessionResult = {
        ...donePayload,
        timestamp: Date.now(),
        prompt: message.slice(0, 200)
      };
      activeSessions.delete(currentSessionId || trackingId);
      logToFile("cache", `Session result cached: ${currentSessionId}`);

      // Send to browser if still connected
      send("done", donePayload);
      res.end();
    }
  }

  function findLatestScreenshot() {
    let best = null;
    if (fs.existsSync(SCREENSHOT_DIR)) {
      try {
        const entries = fs.readdirSync(SCREENSHOT_DIR)
          .filter(f => f.endsWith(".png"))
          .map(f => ({ fp: path.join(SCREENSHOT_DIR, f), time: fs.statSync(path.join(SCREENSHOT_DIR, f)).mtimeMs }))
          .filter(({ time }) => Date.now() - time < 1800000);
        for (const e of entries) {
          if (!best || e.time > best.time) best = e;
        }
      } catch {}
    }
    if (best) latestScreenshotPath = best.fp;
  }

  function findLatestScreenshotUrl() {
    findLatestScreenshot();
    return latestScreenshotPath
      ? `/api/screenshot/file?path=${encodeURIComponent(latestScreenshotPath)}`
      : null;
  }

  // stdout → parse JSON lines
  proc.stdout.on("data", chunk => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  });

  proc.stderr.on("data", chunk => {
    const text = chunk.toString().trim();
    if (text) logToFile("stderr", text.slice(0, 300));
  });

  proc.on("close", exitCode => {
    clearInterval(keepalive);
    if (buffer.trim()) processLine(buffer);
    logToFile("claude", `Process exited with code ${exitCode}`);

    // FIX 6: Cache result even if browser already disconnected
    if (!lastSessionResult || lastSessionResult.sessionId !== currentSessionId) {
      findLatestScreenshot();
      lastSessionResult = {
        sessionId: currentSessionId,
        isError: exitCode !== 0,
        latestScreenshot: findLatestScreenshotUrl(),
        timestamp: Date.now(),
        prompt: message.slice(0, 200)
      };
      activeSessions.delete(currentSessionId || trackingId);
    }

    if (!res.writableEnded) {
      send("done", {
        sessionId: currentSessionId,
        isError: exitCode !== 0,
        latestScreenshot: findLatestScreenshotUrl()
      });
      res.end();
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // FIX 7: Browser disconnect handler — DO NOT kill Claude
  // The Cloudflare tunnel drops connections frequently. If we kill
  // Claude here, all generation work is lost. Instead, let Claude
  // finish and cache the result for /api/session/latest recovery.
  // ═══════════════════════════════════════════════════════════════════
  res.on("close", () => {
    browserDisconnected = true;
    clearInterval(keepalive);

    if (!proc.killed) {
      // OLD (broken): proc.kill("SIGTERM")
      // NEW: Let Claude finish — result will be cached
      logToFile("claude",
        "Browser/tunnel disconnected — Claude continues running. " +
        "Result will be cached in /api/session/latest for recovery."
      );
    }
  });
});

// ── Serve frontend ──
const FRONTEND_DIR = path.resolve(__dirname, "../dist");
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  app.get("*", (req, res) => {
    if (!req.path.startsWith("/api/") &&
        !req.path.startsWith("/screenshots") &&
        !req.path.startsWith("/thumbnails") &&
        !req.path.startsWith("/ue")) {
      res.sendFile(path.join(FRONTEND_DIR, "index.html"));
    }
  });
  console.log("  Frontend served from:", FRONTEND_DIR);
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║       SimWorld Studio Backend                        ║
╠══════════════════════════════════════════════════════╣
║  Listening : http://0.0.0.0:${PORT}                    ║
║  Claude    : ${CLAUDE_BIN}                              ║
║  MCP config: mcp.json (local stdio)                  ║
║  UE TCP    : ${UNREAL_HOST}:${UNREAL_PORT}                   ║
║  Logs      : ${LOG_DIR}            ║
║                                                      ║
║  Tunnel-resilience fixes:                            ║
║    ✓ 8s keepalive pings (defeats proxy timeouts)     ║
║    ✓ no-transform header (defeats proxy buffering)   ║
║    ✓ Claude survives browser disconnects             ║
║    ✓ Session results cached for recovery             ║
║    ✓ GET /api/session/latest for reconnection        ║
╚══════════════════════════════════════════════════════╝
`);
});