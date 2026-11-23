# herdr-durable

Keep Claude Code, Codex, and other agents running in your [Herdr](https://herdr.dev) panes across server restarts.

The built-in herdr restore drops permission and sandbox bypass flags such as `--dangerously-bypass-approvals-and-sandbox` and `--dangerously-skip-permissions`. herdr-durable reports a resume command that keeps those flags. Herdr saves it with the pane and runs it on restore.

| Running in the pane | After a restart |
| --- | --- |
| Claude Code | Reopens with that option: `claude <options> --resume <id>` |
| Codex | Reopens with that option: `codex <options> resume <id>` |
| Other agent or process | Herdr's built-in restore |

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

## Troubleshooting

See what the plugin reported:

```sh
herdr plugin log list --plugin herdr-durable
```

See the command Herdr will run for each pane: look for `agent_resume` in `~/.config/herdr/session.json`, or `~/.config/herdr/sessions/<name>/session.json` for a named session.

## Development

```sh
npm test                                             # unit tests
npm run test:e2e                                     # headless Herdr with fake agents
node e2e.js real claude <session-id> codex <session-id>   # real agents, no prompts sent
```

## License

[MIT](LICENSE)
