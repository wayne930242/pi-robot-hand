# pi-robot-hand

The lazy kit for [pi](https://pi.dev): too lazy to open an IDE, too lazy to copy and paste, not lazy enough to switch off the safety net.

Some things the agent cannot or should not do itself: `/reload`, a `sudo` command, an `ssh` login, a token that belongs in `.env`.
pi-robot-hand hands them to you in one keystroke and brings the result back to the agent:

- **`robot_hand`**: the agent hands you a command for your pi prompt, the clipboard, or a new Herdr pane. The agent never runs it.
- **`!` follow-up**: after a `!command` you type finishes, the agent reads its output and answers.
- **`secret_drop`**: you type a secret into a masked dialog. The agent never sees the value.

```bash
pi install npm:pi-robot-hand
```

## `robot_hand`

The agent calls `robot_hand` with a command and a one-line reason, and pi shows a selector:

```
 Robot Hand — 需要 sudo 重啟服務

   ! sudo systemctl restart nginx

 → Type it into a new Herdr pane (I press Enter)
   Put it in my prompt
   Copy it to the clipboard
   Run it in a new Herdr pane
   No, thanks
```

- **Prompt**: the command lands in your prompt as `! command`, or as-is for a pi command such as `/reload`. Press Enter to run it.
- **Clipboard**: the raw command, for another terminal.
- **Herdr pane**: when pi runs inside [Herdr](https://herdr.dev), a pane opens below pi with the command ready to edit and run, or already running. The pane is a real terminal, so password prompts, `y/N` confirmations, `ssh`, and full-screen programs work. When the command finishes, the pane closes and its output and exit code come back to the agent.

The agent sets `default` to choose which option the selector starts on, and picks the Herdr pane for commands that need terminal input.
Options this session cannot offer are hidden: the clipboard outside the terminal UI, Herdr outside Herdr.
The pane runs the command with your `PATH` but without your `.zshrc`, so shell aliases are not available.

## `!` follow-up

Pi records a `!command`'s output but waits for your next message.
With pi-robot-hand, the agent answers as soon as the command finishes.
`!!` commands, cancelled commands, and commands typed while the agent is busy keep pi's behavior.

## `secret_drop`

1. The agent calls `secret_drop` with where the secret goes and the steps to get it.
2. You type or paste the secret into a masked dialog, or press Tab to ask the agent a question instead.
3. Your prompt now holds a `!` command that applies it. Press Enter:

   ```
   ✓ secret-drop: updated DB_PASSWORD (1 line) in ./.env (env DB_PASSWORD, mode 644) — length check passed (28 chars)
   ```

The agent sees only that report. Afterwards it cannot read the destination, and the value is redacted from tool output.
It can set a `.env` key, replace a regex match, write a whole file, or feed the secret to a command such as `gh secret set`.
`/secret-drop` lists protected files.
See [docs/secret-drop.md](https://github.com/wayne930242/pi-robot-hand/blob/main/docs/secret-drop.md) for parameters, protection details, and limits.

## Safety

pi-robot-hand depends on no other extension.
You run every command it hands over, so command guards such as [cc-safety-net](https://github.com/kenryu42/cc-safety-net) keep checking everything the agent runs, and the two work side by side.
A guard that scans tool input may block `robot_hand` when a command names a sensitive path such as `.env`; the agent then writes the command in chat for you to run.

## Upgrading from pi-secret-drop

`secret_drop` used to be the separate `pi-secret-drop` package.
While it is still installed, pi-robot-hand leaves `secret_drop` to it and warns you to remove it with `pi remove npm:pi-secret-drop`.
Protected files carry over.

## Development

```bash
npm install
npm run check   # tsc --noEmit
npm test        # builds dist/, then node --test
```

Push a `v<version>` tag matching `package.json` to publish through GitHub Actions.

## License

MIT
