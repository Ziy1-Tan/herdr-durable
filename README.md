# herdr-durable

Keep Claude Code, Codex, and Pi running in your [Herdr](https://herdr.dev) panes across server restarts.

Herdr saves your workspaces, tabs, panes, and agent sessions when its server stops, and restores them when it starts again. The built-in restore command does not keep the options a chat was started with. herdr-durable remembers the original launch arguments and sends the right resume command back to the same pane.

| Running in the pane | After a restart |
| --- | --- |
| Claude Code with `--permission-mode` | Reopens with that option: `claude <options> --resume <id>` |
| Codex with `--yolo` | Reopens with that option: `codex <options> resume <id>` |
| Pi | Reopens on its conversation: `pi <options> --session <path>` |
| Plain shell or non-agent process | Left alone |

Chats come back in the same pane, tab, workspace, and folder.

## Install

```sh
herdr plugin install ziy1-tan/herdr-durable
```

Update:

```sh
herdr plugin update herdr-durable
```

Uninstall:

```sh
herdr plugin action invoke herdr-durable.enable-native-resume
herdr plugin uninstall herdr-durable
```

## How it works

1. On `pane_agent_detected` and `pane_agent_status_changed`, the plugin records the pane, agent, session, cwd, and foreground argv.
2. On plugin startup, it reads restored panes, matches saved sessions, and runs the reconstructed resume command in each matching pane.
3. Saved state is kept. Panes with a live agent process are left unchanged, so a manual restore can retry a failed resume.

State is stored only in Herdr's plugin state directory.

## Manual recovery

Automatic restore runs when Herdr starts. If a resume fails, or you want to inspect what was saved:

```sh
herdr plugin action invoke herdr-durable.status
herdr plugin action invoke herdr-durable.restore-dry-run
herdr plugin action invoke herdr-durable.restore
herdr plugin action invoke herdr-durable.save
```

Herdr shows a notification with the result. The full JSON is in `herdr plugin log list --plugin herdr-durable`.

- `status` shows every saved pane, whether the pane still exists, and whether its session file is present.
- `restore-dry-run` shows the exact commands without running them.
- `restore` retries only idle panes with saved sessions. Running agents are skipped, so it is safe to run again.
- `save` captures the agents running in Herdr now.

The plugin never starts an agent when its session file is missing, because that would open a blank conversation. Restore the transcript from a backup, or start a new chat.

## Test

```sh
npm test
npm run test:e2e
npm run test:e2e -- codex
```

`npm test` covers command construction, session validation, capture, and multi-pane restore logic. `npm run test:e2e` starts a headless Herdr server, seeds a session snapshot, and restores fake Codex, Claude, and Pi panes. It needs no model access.

For a release check against the real agents, run `npm run test:e2e:real` after signing in to each agent and trusting the repository directory.

## License

[MIT](LICENSE)
