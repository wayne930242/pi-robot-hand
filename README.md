# pi-robot-hand

A [pi](https://pi.dev) extension that lets the agent hand the user a command to run themselves.

1. The agent calls `robot_hand` with a command and a one-line reason.
2. Pi shows an inline selector in place of the prompt, with the reason and exactly what the user would run.
3. The user picks one:
   - **Put it in my prompt**: a shell command lands as `! command`, a pi slash command such as `/reload` lands as-is. Pressing Enter runs it; a `!` command's output returns to the conversation.
   - **Copy it to the clipboard**: the raw shell command, for another terminal.
   - **No, thanks**: nothing is placed.
4. The tool returns the choice. After a prompt or clipboard hand-over the agent's turn ends, so the next move is the user's.

The agent never runs the command. It suits commands the user has to run: pi slash commands, `sudo` or interactive commands, and commands a safety extension blocks for the agent.

```
 robot_hand 需要 sudo 重啟服務
   ! sudo systemctl restart nginx
 ──────────────────────────────────────────────
 Robot Hand — 需要 sudo 重啟服務

   ! sudo systemctl restart nginx

 → Put it in my prompt
   Copy it to the clipboard
   No, thanks

 ↑↓ navigate  enter select  escape/ctrl+c cancel
 ──────────────────────────────────────────────
```

## Install

```bash
pi install npm:pi-robot-hand
```

## Tool: `robot_hand`

| Parameter | Description |
|---|---|
| `command` | The command. Shell commands go without a leading `!`; pi commands start with `/`. |
| `reason` | One short line telling the user why, in the user's language. |
| `kind` | `shell` (default) or `pi`. |

When the prompt already holds a draft, the prompt option says it replaces the draft. The clipboard option appears only for shell commands in the terminal UI. RPC clients get the prompt option; modes without a UI make the tool fail so the agent shows the command in chat.

## Development

```bash
npm install
npm run check   # tsc --noEmit
npm test        # node --test
```

Releases publish from GitHub Actions through npm trusted publishing: bump `version` in `package.json`, commit, and push a matching `v<version>` tag.

## License

MIT
