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
3. A successful restore deletes the record. Panes with a live agent process are left unchanged.

State is stored only in Herdr's plugin state directory.

## Test

```sh
npm test
npm run test:e2e -- codex
npm run test:e2e -- claude
npm run test:e2e -- pi
```

## License

[MIT](LICENSE)
