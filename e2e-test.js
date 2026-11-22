#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    throw new Error(`usage: node e2e-test.js [${SUPPORTED_AGENTS.join("|")} ...]`);
  }
}

const FLAGS = {
  codex: ["--no-daemon", "--yolo"],
  claude: ["--dangerously-skip-permissions", "--model", "opus"],
  pi: ["--profile", "work"],
};

function resumeArguments(agent, session) {
  if (agent === "codex") return ["resume", session];
  if (agent === "claude") return ["--resume", session];
  return ["--session", session];
}

function agentSession(agent, value) {
  return agent === "pi"
    ? { source: "herdr:pi", agent, kind: "path", value }
    : { source: `herdr:${agent}`, agent, kind: "id", value };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const started = Date.now();
const { root, home } = makeHome("restore");
const env = cleanEnv(home);
const sessionName = "durable-restore-e2e";
const folder = join(root, "project");
const runsDir = join(root, "runs");
const fakeBin = join(root, "bin");
const codexSessions = join(home, ".codex", "sessions", "project");
const claudeSessions = join(home, ".claude", "projects", "project");
const piSessions = join(home, ".pi", "agent", "sessions", "project");

for (const directory of [folder, runsDir, fakeBin, codexSessions, claudeSessions, piSessions]) {
  mkdirSync(directory, { recursive: true });
}
writeConfig(home, "onboarding = false\n\n[session]\nresume_agents_on_restore = false\n");
env.PATH = `${fakeBin}:${env.PATH}`;

for (const agent of SUPPORTED_AGENTS) {
  const file = join(fakeBin, agent);
  writeFileSync(file, `#!/bin/sh
id=""
for arg in "$@"; do
  case "$arg" in --durable-id=*) id="\${arg#--durable-id=}" ;; esac
done
[ -n "$id" ] || id="unknown-$$"
{
  printf 'cwd=%s\\n' "$PWD"
  printf 'arg=%s\\n' "$@"
} > ${JSON.stringify(runsDir)}/"$id".log
sleep 60
`, { mode: 0o755 });
}

function seedSession(agent, id, seed) {
  if (!seed) return `missing-${id}`;
  if (agent === "codex") {
    writeFileSync(join(codexSessions, `rollout-${id}.jsonl`), "");
    return id;
  }
  if (agent === "claude") {
    writeFileSync(join(claudeSessions, `${id}.jsonl`), "");
    return id;
  }
  const file = join(piSessions, `${id}.jsonl`);
  writeFileSync(file, "");
  return file;
}

const tabs = [];
const specs = [];
let paneNumber = 0;

function makeSpec(agent, { seed = true } = {}) {
  paneNumber += 1;
  const label = `pane${paneNumber}`;
  const id = `${agent}-session-${paneNumber}`;
  const session = seedSession(agent, id, seed);
  const flags = FLAGS[agent];
  return {
    agent,
    label,
    session,
    seed,
    argv: [`/${agent}`, ...flags, `--durable-id=${label}`],
    expected: [...flags, `--durable-id=${label}`, ...resumeArguments(agent, session)],
    agentSession: agentSession(agent, session),
  };
}

function addTab(name, tabSpecs) {
  tabs.push({
    name,
    panes: tabSpecs.map(spec => ({ label: spec.label, agentSession: spec.agentSession })),
  });
  specs.push(...tabSpecs);
}

for (const agent of agents) {
  addTab(agent, [makeSpec(agent)]);
}

const splitAgents = agents.length >= 2
  ? agents.slice(0, 2)
  : [agents[0], agents[0]];
addTab("split", splitAgents.map(agent => makeSpec(agent)));

const skipped = makeSpec("codex", { seed: false });
addTab("missing-session", [skipped]);

const validSpecs = specs.filter(spec => spec.seed);
const neededPanes = specs.length;

function recordFile(paneId) {
  return join(pluginStateDir(home), `${encodeURIComponent(paneId)}.json`);
}

function readRecord(paneId) {
  try {
    return JSON.parse(readFileSync(recordFile(paneId), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function clearRuns() {
  rmSync(runsDir, { recursive: true, force: true });
  mkdirSync(runsDir, { recursive: true });
}

function readRun(label) {
  const file = join(runsDir, `${label}.log`);
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").trim().split("\n");
  return {
    cwd: lines[0].replace(/^cwd=/, ""),
    args: lines.slice(1).map(line => line.replace(/^arg=/, "")),
  };
}

function waitForRuns() {
  waitFor(
    () => validSpecs.every(spec => existsSync(join(runsDir, `${spec.label}.log`))),
    `restore runs for ${validSpecs.map(spec => spec.label).join(", ")}`,
  );
}

function assertRuns() {
  for (const spec of validSpecs) {
    const run = readRun(spec.label);
    assert.ok(run, `missing run for ${spec.label}`);
    assert.equal(run.cwd, folder, `${spec.label} restored in the wrong folder`);
    assert.deepEqual(run.args, spec.expected, `${spec.label} restored with the wrong argv`);
  }
  assert.equal(readRun(skipped.label), null, "pane with a missing session should not be restored");
}

function waitForCapture() {
  waitFor(
    () => validSpecs.every(spec => {
      const record = readRecord(spec.paneId);
      return record?.argv?.includes(join(fakeBin, spec.agent));
    }),
    "pane state to be captured again after restore",
  );
}

let server;
try {
  writeSnapshot(home, sessionName, buildSnapshot({ cwd: folder, tabs }));

  linkPlugin(env, { disabled: true });
  server = startServer({ session: sessionName, env });
  const panes = server.run(["pane", "list"]).result.panes;
  await server.stop();

  const paneByLabel = new Map(panes.map(pane => [pane.label, pane]));
  assert.equal(panes.length, neededPanes, "snapshot did not restore every pane");
  for (const spec of specs) {
    const pane = paneByLabel.get(spec.label);
    assert.ok(pane, `missing restored pane ${spec.label}`);
    spec.paneId = pane.pane_id;
  }

  mkdirSync(pluginStateDir(home), { recursive: true });
  for (const spec of specs) {
    writeFileSync(recordFile(spec.paneId), `${JSON.stringify({
      agent: spec.agent,
      session: spec.session,
      argv: spec.argv,
    }, null, 2)}\n`);
  }

  linkPlugin(env);
  clearRuns();
  server = startServer({ session: sessionName, env });
  waitForRuns();
  sleep(300);
  assertRuns();
  waitForCapture();
  assert.equal(
    readRecord(skipped.paneId).session,
    skipped.session,
    "skipped pane state should be left untouched",
  );
  await server.stop();

  clearRuns();
  server = startServer({ session: sessionName, env });
  waitForRuns();
  sleep(300);
  assertRuns();
  assert.equal(
    readRecord(skipped.paneId).session,
    skipped.session,
    "skipped pane state should survive a second restart",
  );
  await server.stop();

  console.log(JSON.stringify({
    agents,
    panes: specs.length,
    restored: validSpecs.length,
    skipped: specs.length - validSpecs.length,
    ms: Date.now() - started,
  }));
} catch (error) {
  if (server) console.error(server.output());
  throw error;
} finally {
  try {
    await server?.stop();
  } catch {}
  if (!process.env.HERDR_DURABLE_DEBUG) {
    rmSync(root, { recursive: true, force: true });
  }
}
