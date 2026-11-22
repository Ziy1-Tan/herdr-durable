#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildSnapshot,
  cleanEnv,
  linkPlugin,
  makeHome,
  pluginStateDir,
  startServer,
  waitFor,
  writeConfig,
  writeSnapshot,
} from "./e2e-harness.js";

const SUPPORTED_AGENTS = ["codex", "claude", "pi"];
const requested = process.argv.slice(2);
const agents = requested.length === 0 ? SUPPORTED_AGENTS : [...new Set(requested)];
for (const agent of agents) {
  if (!SUPPORTED_AGENTS.includes(agent)) {
    throw new Error(`usage: node e2e-real.js [${SUPPORTED_AGENTS.join("|")} ...]`);
  }
}

const realHome = homedir();

async function runAgent(agent) {
  const started = Date.now();
  const { root, home } = makeHome(`real-${agent}`);
  const env = cleanEnv(home, {
    HERDR_DURABLE_CODEX_SESSIONS: join(realHome, ".codex", "sessions"),
    HERDR_DURABLE_CLAUDE_SESSIONS: join(realHome, ".claude", "projects"),
    HERDR_DURABLE_PI_SESSIONS: join(realHome, ".pi", "agent", "sessions"),
  });
  const sessionName = `durable-real-${agent}`;
  const folder = join(root, "project");
  mkdirSync(folder, { recursive: true });
  writeConfig(home, "onboarding = false\n\n[session]\nresume_agents_on_restore = false\n");
  writeSnapshot(home, sessionName, buildSnapshot({
    cwd: folder,
    tabs: [{ name: "shell", panes: [{ label: "shell" }] }],
  }));
  linkPlugin(env);

  let server;
  try {
    server = startServer({ session: sessionName, env });
    const source = server.run(["pane", "list"]).result.panes[0];
    assert.ok(source, "headless Herdr did not create a shell pane");
    const pane = server.run([
      "pane", "split", source.pane_id,
      "--direction", "right",
      "--cwd", process.cwd(),
      "--env", `HOME=${realHome}`,
      "--no-focus",
    ]).result.pane;
    const agentName = `durable-${agent}-${Date.now()}`;

    server.run(["agent", "start", agentName, "--kind", agent, "--pane", pane.pane_id]);
    server.run(
      ["agent", "prompt", agentName, "Reply with ok only", "--wait"],
      { timeout: 120_000 },
    );

    const paneState = waitFor(() => {
      const current = server.run(["pane", "list"]).result.panes
        .find(candidate => candidate.pane_id === pane.pane_id);
      return current?.agent_session ? current : null;
    }, `${agent} session`, 30_000);

    const recordFile = join(pluginStateDir(home), `${encodeURIComponent(pane.pane_id)}.json`);
    waitFor(() => existsSync(recordFile), `${agent} pane state`, 15_000);
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    assert.equal(record.session, paneState.agent_session.value, `${agent} captured the wrong session`);

    await server.stop();
    server = startServer({ session: sessionName, env });
    waitFor(() => {
      const info = server.run(["pane", "process-info", "--pane", pane.pane_id]).result.process_info;
      return (info.foreground_processes || []).some(process => process.name === agent);
    }, `${agent} restored process`, 30_000);

    const restored = server.run(["pane", "list"]).result.panes
      .find(candidate => candidate.pane_id === pane.pane_id);
    assert.equal(restored.agent_session.value, record.session, `${agent} restored the wrong session`);

    return {
      agent,
      pane_id: pane.pane_id,
      session: record.session,
      argv: record.argv,
      ms: Date.now() - started,
    };
  } finally {
    try {
      await server?.stop();
    } catch {}
    if (!process.env.HERDR_DURABLE_DEBUG) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

const results = [];
for (const agent of agents) {
  results.push(await runAgent(agent));
}
console.log(JSON.stringify(results, null, 2));
