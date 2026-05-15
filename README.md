# pi-para-agents pi extension

Spawn and manage interactive pi agents in tmux windows from a parent pi session.

## Install

```bash
pi install git:github.com/bdatdo0601/pi-para-agents
```

For one-off use without installing globally:

```bash
pi -e git:github.com/bdatdo0601/pi-para-agents
```

## Commands

- `/spawn <prompt>` — create a new tmux window running `pi --session <agent-session> @prompt.md` in the current cwd using the inline prompt.
- `/spawn` — open a blank editor for the initial agent prompt, then launch the agent.
- `/para-fork <prompt>` — create a new tmux agent whose session is forked from the current parent's active Pi session branch, then send the inline prompt.
- `/para-fork` — open a blank editor, then fork the current session branch into a parallel agent with that prompt.
- `/agent-list [cwd|--all]` — open a 90%-screen live TUI list of tracked agents. Each row shows a colored tmux badge dot, the agent state (`in progress`, `idle`, or `needs response`), and a single `latest:` line with the best current message/action for that agent. Defaults to the current cwd.
  - `↑/↓` select
  - `enter` or `a` attach/switch to the agent window
  - `k` kill selected agent
  - `r` refresh
  - `q` or `esc` close
- `/agent-attach <id>` — open a live agent in this terminal by id prefix. Inside tmux it switches to the agent window; outside tmux it hands the terminal to `tmux attach` until you detach, then resumes the parent Pi TUI.
- `/kill-agent <id>` — kill an agent by id prefix.
- `/kill-all-agents [cwd|--all]` — kill every tracked agent for the current cwd by default. Pass a cwd to scope it, or `--all` to kill agents across every cwd.

## Behavior

- If pi is already inside tmux, agents are spawned as new windows in the current tmux session.
- If pi is not inside tmux, agents are spawned in a detached session named `pi-agents`.
- When `/agent-attach` opens a detached tmux session, detach with your tmux prefix then `d` to return to the parent Pi terminal. The parent Pi UI is suspended while the same terminal is attached to tmux; the parent process/event loop is not synchronously blocked.
- Inside spawned agents, the extension shows a startup notification plus a below-editor hint explaining how to return (`ctrl+t d` for detached sessions, `ctrl+t l`/window switch when spawned inside the same tmux session). Bare `/agent-list` inside a spawned agent uses that agent's original cwd, so it shows sibling agents for the same project even if Pi reports a different session cwd.
- Spawned agents inherit parent CLI resource flags for extensions, skills, prompt templates, themes, context-file/tool toggles, and explicit tool allowlists. They also explicitly pass the parent session's loaded extension paths and active tool allowlist (`--tools ...`) so agents launched after `/reload` get the same extension tools/commands.
- `/para-fork` additionally writes a child session file containing the current active parent session branch (falling back to all known entries if no leaf is selected). The child session header points back to the parent session via `parentSession`, so Pi's tree/session lineage remains intact.
- Agent metadata, prompt files, status files, logs, and per-agent pi session files live under `~/.pi/agent/pi-para-agents/`.
- Existing state from `~/.pi/agent/tmux-agents/` is migrated automatically on first use.
- The footer shows `agents:<n>` when there are running agents for the current cwd. Parent `/agent-list` reads child activity updates from `activity.json`, session history, and filtered tmux pane output to show in-progress/idle/needs-response state plus each agent's latest useful message.
- Killed agents are removed from the registry immediately; their state directory is left on disk for log/session inspection.

## Environment variables

- `PI_TMUX_AGENT_SESSION` — override the detached tmux session name.
- `PI_CODING_AGENT_DIR` — pi config/state root; defaults to `~/.pi/agent`.

## tmux setup

For best pi key handling inside tmux, add this to `~/.tmux.conf`:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

Then restart tmux with `tmux kill-server && tmux`.
