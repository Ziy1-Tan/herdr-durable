#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bin="$root/fake-herdr"
state=$(mktemp -d)
mkdir -p "$state/state"

cat >"$bin" <<'EOF'
#!/bin/sh
log="${HERDR_DURABLE_COMMAND_LOG:-/dev/null}"
case "$*" in
  'pane run w1:p1 codex --yolo resume sess') printf '%s\n' 'pane run w1:p1 codex --yolo resume sess' >> "$log"; printf '%s\n' '{"id":"x","result":{"ok":true}}' ;;
  'pane run w1:p2 claude --model x --resume csess') printf '%s\n' 'pane run w1:p2 claude --model x --resume csess' >> "$log"; printf '%s\n' '{"id":"x","result":{"ok":true}}' ;;
  'pane run w1:p3 pi --profile x --session /sessions/psess') printf '%s\n' 'pane run w1:p3 pi --profile x --session /sessions/psess' >> "$log"; printf '%s\n' '{"id":"x","result":{"ok":true}}' ;;
  'pane list') printf '%s\n' '{"id":"x","result":{"panes":[{"pane_id":"w1:p1","agent":"codex","cwd":"/repo","agent_session":{"source":"herdr:codex","agent":"codex","kind":"id","value":"sess"}},{"pane_id":"w1:p2","agent":"claude","cwd":"/repo","agent_session":{"source":"herdr:claude","agent":"claude","kind":"id","value":"csess"}},{"pane_id":"w1:p3","agent":"pi","cwd":"/repo","agent_session":{"source":"herdr:pi","agent":"pi","kind":"path","value":"/sessions/psess"}}]}}' ;;
  'pane get w1:p1') printf '%s\n' '{"id":"x","result":{"pane":{"pane_id":"w1:p1","agent":"codex","cwd":"/repo","agent_session":{"source":"herdr:codex","agent":"codex","kind":"id","value":"sess"}}}}' ;;
  'pane process-info --pane w1:p1') printf '%s\n' "{\"id\":\"x\",\"result\":{\"process_info\":{\"foreground_processes\":[{\"pid\":123,\"argv\":[\"zsh\"],\"name\":\"${HERDR_DURABLE_P1_AGENT:-zsh}\"}]}}}" ;;
  'pane process-info --pane w1:p2') printf '%s\n' "{\"id\":\"x\",\"result\":{\"process_info\":{\"foreground_processes\":[{\"pid\":124,\"argv\":[\"zsh\"],\"name\":\"${HERDR_DURABLE_P2_AGENT:-zsh}\"}]}}}" ;;
  'pane process-info --pane w1:p3') printf '%s\n' "{\"id\":\"x\",\"result\":{\"process_info\":{\"foreground_processes\":[{\"pid\":125,\"argv\":[\"zsh\"],\"name\":\"${HERDR_DURABLE_P3_AGENT:-zsh}\"}]}}}" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$bin"
printf '%s\n' '{"version":1,"panes":{"w1:p1":{"agent":"codex","session":"sess","session_kind":"id","cwd":"/repo","argv":["/codex","--yolo"],"saved_at":"now"},"w1:p2":{"agent":"claude","session":"csess","session_kind":"id","cwd":"/repo","argv":["/claude","--model","x"],"saved_at":"now"},"w1:p3":{"agent":"pi","session":"/sessions/psess","session_kind":"path","cwd":"/repo","argv":["/pi","--profile","x"],"saved_at":"now"}}}' >"$state/state/state.json"

HERDR_DURABLE_COMMAND_LOG="$state/runs" \
  HERDR_BIN_PATH="$bin" \
  HERDR_PLUGIN_STATE_DIR="$state/state" \
  node "$root/plugin.js" restore
HERDR_BIN_PATH="$bin" HERDR_PLUGIN_STATE_DIR="$state/state" node "$root/plugin.js" restore
node -e 'const state = JSON.parse(require("fs").readFileSync(process.argv[1])); if (Object.keys(state.panes).length !== 0) process.exit(1)' "$state/state/state.json"
node -e 'const fs=require("fs"); const runs=fs.readFileSync(process.argv[1],"utf8").trim().split(String.fromCharCode(10)); if (runs.length!==3) process.exit(1)' "$state/runs"

rm -rf "$state"
rm -f "$bin"
