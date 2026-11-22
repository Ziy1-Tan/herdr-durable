# herdr-durable

Keep Claude Code, Codex, and Pi running in your [Herdr](https://herdr.dev) panes across server restarts.

The built-in herdr restore drops permission and sandbox bypass flags such as `-dangerously-bypass-approvals-and-sandbox` and `--dangerously-skip-permissions`. herdr-durable remembers the original launch arguments and sends the right resume command back to the same pane.

| Running in the pane | After a restart |
| --- | --- |
| Claude Code | Reopens with that option: `claude <options> --resume <id>` |
| Codex | Reopens with that option: `codex <options> resume <id>` |
| Pi | Reopens it: `pi <options> --session <path>` |
| Non-agent process | Left alone |

## Prerequisites

Set this in `~/.config/herdr/config.toml`:

```toml
[session]
resume_agents_on_restore = false
```

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
herdr plugin uninstall herdr-durable
```

## How it works

1. The plugin records each agent's pane, session, and launch arguments while it runs.
2. On Herdr startup, it matches saved sessions with restored panes and sends each pane its original resume command.
3. Saved state is kept. Only idle panes are restored, so a failed resume can be retried manually.

State is stored only in Herdr's plugin state directory.

## Using it

Automatic restore runs when Herdr starts. The actions help inspect or retry saved sessions:

```sh
herdr plugin action invoke herdr-durable.status          # Show saved sessions
herdr plugin action invoke herdr-durable.restore-dry-run # Preview resume commands
herdr plugin action invoke herdr-durable.restore         # Retry restore in idle panes
herdr plugin action invoke herdr-durable.save            # Capture agents running now
```

## License

[MIT](LICENSE)
