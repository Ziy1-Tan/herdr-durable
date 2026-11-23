# herdr-durable

Keep Claude Code and Codex in your [Herdr](https://herdr.dev) panes in the same mode across server restarts.

Herdr resumes agent sessions after a restart, but its built-in resume command is only `claude --resume <id>` or `codex resume <id>`. Launch flags such as `--dangerously-skip-permissions` and `--dangerously-bypass-approvals-and-sandbox` are dropped, so restored agents silently fall back to asking for approval.

herdr-durable reports a resume command that keeps those flags. Herdr saves it with the pane and runs it on restore.

| Running in the pane | After a restart |
| --- | --- |
| `claude --dangerously-skip-permissions --model opus` | `claude --dangerously-skip-permissions --model opus --resume <id>` |
| `codex --dangerously-bypass-approvals-and-sandbox -p work` | `codex --dangerously-bypass-approvals-and-sandbox -p work resume <id>` |
| Any other agent or process | Herdr's normal restore |

## Requirements

- Herdr 0.9.5 or later, with its Claude Code and Codex integrations installed (`herdr integration install claude`, `herdr integration install codex`).
- Node.js 18 or later.
- Herdr's native agent restore turned on. It is on by default. If your `~/.config/herdr/config.toml` has `resume_agents_on_restore = false`, remove it. herdr-durable 1.x needed it turned off; 2.x needs it on.

## Install

```sh
herdr plugin install Ziy1-Tan/herdr-durable
```

Update or remove it:

```sh
herdr plugin update herdr-durable
herdr plugin uninstall herdr-durable
```

Agents already running when you install are picked up at the next Herdr start, or right away with:

```sh
herdr plugin action invoke herdr-durable.sync
```

## How it works

1. When Herdr detects Claude Code or Codex in a pane, or its state changes, the plugin reads the pane's session id and the agent's launch argv from Herdr.
2. It builds a resume command from the launch flags and reports it with `herdr pane report-agent-session ... -- <command>`.
3. Herdr stores the command in its session snapshot and runs it when it restores the pane.

The plugin keeps no state and never types into panes. Herdr owns saving and restoring.

### Which flags are kept

Every launch flag is kept except these:

- options that pick a session: Claude `--resume`, `--continue`, `--session-id`, `--fork-session`, `--from-pr`, `--teleport`, `--cloud`; Codex `resume --last`, `--all`
- options that do one-time work on start: Claude `--worktree`, `--tmux`, `--file`, `--environment`; Codex `--worktree`, `--image`
- prompts and other positional arguments

Non-interactive runs such as `claude -p` and `codex exec` are left alone.

A session with no messages has nothing to resume yet. Until its first message, the restore starts a new session with the same flags (Claude keeps the same session id).

Herdr rejects resume commands with an apostrophe or control character in an argument, more than 64 arguments, or more than 8 KiB. For those panes the plugin reports nothing and Herdr's normal restore applies.

## Troubleshooting

See what the plugin reported:

```sh
herdr plugin log list --plugin herdr-durable
```

See the command Herdr will run for each pane: look for `agent_resume` in `~/.config/herdr/session.json`, or `~/.config/herdr/sessions/<name>/session.json` for a named session.

## Development

```sh
npm test                # unit tests
npm run test:e2e        # headless Herdr with fake agents
node e2e-real.js claude <session-id> codex <session-id>   # real agents, no prompts sent
```

## License

[MIT](LICENSE)
