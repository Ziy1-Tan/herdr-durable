import { TuiTest } from "@microsoft/tui-test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const agent = process.argv[2];
const supportedAgents = new Set(["codex", "claude", "pi"]);
if (!supportedAgents.has(agent)) {
  throw new Error("usage: node e2e-test.mjs <codex|claude|pi>");
}

const herdrSession = `herdr-durable-${agent}-e2e`;
const home = mkdtempSync(join(tmpdir(), `${herdrSession}-`));
const configDir = join(home, ".config", "herdr");
mkdirSync(configDir, { recursive: true });
const currentPlugin = JSON.parse(readFileSync(join(homedir(), ".config", "herdr", "plugins.json"), "utf8"))
  .find(plugin => plugin.plugin_id === "herdr-durable");
writeFileSync(join(configDir, "plugins.json"), `${JSON.stringify([currentPlugin], null, 2)}\n`);
writeFileSync(join(configDir, "config.toml"), `onboarding = false\n\n[experimental]\nallow_nested = true\n\n[session]\nresume_agents_on_restore = false\n`);
const agentCwd = process.env.HERDR_DURABLE_AGENT_CWD || process.cwd();
const agentHome = process.env.HERDR_DURABLE_AGENT_HOME || homedir();

const env = {
  ...process.env,
  HOME: home,
  HERDR_CONFIG_PATH: join(configDir, "config.toml"),
};
delete env.HERDR_SOCKET_PATH;
delete env.HERDR_WORKSPACE_ID;
delete env.HERDR_TAB_ID;
delete env.HERDR_PANE_ID;

const stateRoot = join(home, ".local", "state", "herdr", "plugins", "herdr-durable", "panes");
const terminal = TuiTest.ephemeral(herdrSession);
const agentName = `durable-${agent}-${Date.now()}`;
function runHerdr(args) {
  return execFileSync("herdr", ["--session", herdrSession, ...args], {
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
}

function paneList() {
  return JSON.parse(runHerdr(["pane", "list"])).result.panes;
}

function paneById(paneId) {
  return paneList().find(pane => pane.pane_id === paneId);
}

function paneProcess(paneId) {
  return JSON.parse(runHerdr(["pane", "process-info", "--pane", paneId])).result.process_info;
}

function savedRecord(paneId) {
  try {
    return JSON.parse(readFileSync(join(stateRoot, `${encodeURIComponent(paneId)}.json`), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

function waitFor(predicate, description, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`timeout waiting for ${description}`);
}

async function startHerdr() {
  await terminal.submit(`herdr --session ${herdrSession}`);
  waitFor(() => {
    try {
      paneList();
      return true;
    } catch {
      return false;
    }
  }, "Herdr API ready");
}

try {
  await terminal.open({ cwd: process.cwd(), env, waitReady: true });
  await startHerdr();

  const sourcePane = paneList()[0];
  const split = JSON.parse(runHerdr([
    "pane", "split", sourcePane.pane_id, "--direction", "right",
    "--cwd", agentCwd,
    "--env", `HOME=${agentHome}`,
    "--no-focus",
  ]));
  const paneId = split.result.pane.pane_id;
  if (agent === "claude") {
    const trustPane = JSON.parse(runHerdr([
      "pane", "split", paneId, "--direction", "down", "--cwd", agentCwd,
      "--env", `HOME=${agentHome}`, "--no-focus",
    ])).result.pane.pane_id;
    runHerdr(["pane", "run", trustPane, "claude"]);
    try {
      runHerdr(["pane", "wait-output", trustPane, "--match", "Security guide", "--timeout", "5000"]);
      runHerdr(["pane", "send-keys", trustPane, "down"]);
      runHerdr(["pane", "send-keys", trustPane, "enter"]);
    } catch {}
    runHerdr(["pane", "close", trustPane]);
  }
  runHerdr(["agent", "start", agentName, "--kind", agent, "--pane", paneId]);
  runHerdr(["agent", "prompt", agentName, "Reply with ok only", "--wait"]);

  waitFor(() => paneById(paneId)?.agent_session, `${agent} pane session`);
  waitFor(() => savedRecord(paneId)?.argv?.length > 0, `${agent} capture`);

  const record = savedRecord(paneId);
  const capturedPane = paneById(paneId);
  if (capturedPane.agent_session.value !== record.session) throw new Error("captured session mismatch");

  runHerdr(["session", "stop", herdrSession]);
  waitFor(() => {
    try {
      paneList();
      return false;
    } catch {
      return true;
    }
  }, "Herdr session stop");
  await startHerdr();

  waitFor(() => paneProcess(paneId)?.foreground_processes?.some(process => process.name === agent), `${agent} restored process`);
  const restoredPane = paneById(paneId);
  if (restoredPane.agent_session.value !== record.session) throw new Error("restored session mismatch");

  console.log(JSON.stringify({
    agent,
    pane_id: paneId,
    session: record.session,
    argv: record.argv,
  }));
} catch (error) {
  console.error(await terminal.text({ full: true }));
  throw error;
} finally {
  await terminal.closeQuiet();
  try {
    runHerdr(["session", "stop", herdrSession]);
  } catch {}
  if (!process.env.HERDR_DURABLE_DEBUG) rmSync(home, { recursive: true, force: true });
}
