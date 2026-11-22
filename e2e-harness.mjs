import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const HERDR = process.env.HERDR_BIN_PATH || "herdr";

export function makeHome(prefix) {
  const root = mkdtempSync(join(tmpdir(), `herdr-durable-${prefix}-`));
  const home = join(root, "home");
  const configDir = join(home, ".config", "herdr");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(home, ".zshrc"), "");
  writeFileSync(join(home, ".bashrc"), "");
  writeFileSync(join(configDir, "config.toml"), "onboarding = false\n");
  return { root, home, configDir };
}

export function cleanEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, ...extra };
  for (const key of [
    "HERDR_SOCKET_PATH",
    "HERDR_WORKSPACE_ID",
    "HERDR_TAB_ID",
    "HERDR_PANE_ID",
    "HERDR_PLUGIN_STATE_DIR",
  ]) delete env[key];
  return env;
}

export function writeConfig(home, content) {
  writeFileSync(join(home, ".config", "herdr", "config.toml"), content);
}

export function linkPlugin(env, { disabled = false } = {}) {
  const args = ["plugin", "link", REPO_ROOT, ...(disabled ? ["--disabled"] : [])];
  const result = spawnSync(HERDR, args, { env, encoding: "utf8", timeout: 15_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`herdr plugin link failed: ${result.stderr || result.stdout}`);
  }
}

export function runHerdr(session, env, args, { timeout = 30_000 } = {}) {
  const result = spawnSync(HERDR, ["--session", session, ...args], {
    encoding: "utf8",
    env,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

export function waitFor(predicate, description, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timeout waiting for ${description}`);
    Atomics.wait(sleeper, 0, 0, 50);
  }
}

export function startServer({ session, env }) {
  const child = spawn(HERDR, ["--session", session, "server"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const run = (args, options) => runHerdr(session, env, args, options);

  waitFor(() => {
    try {
      run(["pane", "list"]);
      return true;
    } catch {
      return false;
    }
  }, "Herdr API ready");

  return {
    child,
    run,
    output: () => output,
    async stop() {
      try {
        run(["session", "stop", session, "--json"], { timeout: 10_000 });
      } catch {}
      try {
        child.kill("SIGTERM");
      } catch {}
      await waitForExit(child);
    },
  };
}

function waitForExit(child, timeout = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("timeout waiting for Herdr server exit"));
    }, timeout);
    function onExit() {
      clearTimeout(timer);
      resolve();
    }
    child.once("exit", onExit);
  });
}

export function buildSnapshot({ cwd, tabs }) {
  let paneNumber = 0;
  const publicPaneNumbers = {};
  const snapshotTabs = tabs.map(tab => {
    const panes = {};
    const paneIds = tab.panes.map(pane => {
      paneNumber += 1;
      publicPaneNumbers[paneNumber] = paneNumber;
      panes[paneNumber] = {
        cwd: pane.cwd || cwd,
        label: pane.label,
        ...(pane.agentSession ? { agent_session: pane.agentSession } : {}),
      };
      return paneNumber;
    });
    if (paneIds.length < 1 || paneIds.length > 2) {
      throw new Error("snapshot tabs support one or two panes");
    }
    return {
      custom_name: tab.name,
      layout: paneIds.length === 1
        ? { Pane: paneIds[0] }
        : {
            Split: {
              direction: "Horizontal",
              ratio: 0.5,
              first: { Pane: paneIds[0] },
              second: { Pane: paneIds[1] },
            },
          },
      panes,
      zoomed: false,
      focused: paneIds[0],
      root_pane: paneIds[0],
    };
  });

  return {
    version: 3,
    workspaces: [{
      id: "w1",
      custom_name: null,
      identity_cwd: cwd,
      public_pane_numbers: publicPaneNumbers,
      next_public_pane_number: paneNumber + 1,
      public_tab_numbers: snapshotTabs.map((_, index) => index + 1),
      next_public_tab_number: snapshotTabs.length + 1,
      tabs: snapshotTabs,
      active_tab: 0,
    }],
    active: 0,
    selected: 0,
    sidebar_width: null,
    sidebar_section_split: null,
    collapsed_space_keys: [],
  };
}

export function writeSnapshot(home, session, snapshot) {
  const directory = join(home, ".config", "herdr", "sessions", session);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "session.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
}

export function pluginStateDir(home) {
  return join(home, ".local", "state", "herdr", "plugins", "herdr-durable", "panes");
}
