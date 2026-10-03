# pi-robot-hand

The lazy kit for [pi](https://pi.dev): too lazy to open an IDE, too lazy to copy and paste, not lazy enough to switch off the safety net.

When the agent cannot or should not run something itself (a `/reload`, a `sudo` command, an interactive login, a secret going into a config file), you still do not want to leave the conversation. pi-robot-hand moves the command or the secret to you in one keystroke and brings the result back to the agent, while the guards that keep the agent away from dangerous commands and secret files stay on:

- **`robot_hand`**: the agent hands you a command. Pick where it goes: your pi prompt, the clipboard, or a new Herdr pane. The agent never runs it.
- **`!` follow-up**: after a `!command` you type finishes, the agent reads its output and answers, without another message from you.
- **`secret_drop`**: you type a secret into a masked dialog and apply it with a `!` command you can read. The agent never sees the value.

You are the one who runs every command, so a command-guarding extension such as [cc-safety-net](https://github.com/kenryu42/cc-safety-net) keeps checking everything the agent itself runs.

## Install

```bash
pi install npm:pi-robot-hand
```

The package ships three extensions and a `secret-drop` skill that teaches the agent to use `secret_drop` and to let programs consume secret files.

### Upgrading from pi-secret-drop

`secret_drop` used to be the separate `pi-secret-drop` package. Both packages register the same tool, which pi refuses to load, so while `pi-secret-drop` is still in your settings pi-robot-hand leaves `secret_drop` to it and shows a warning with the exact command to remove it:

```bash
pi remove npm:pi-secret-drop@0.1.6   # the source as listed in your settings
```

Protected destinations and their registry in `~/.pi/agent/secret-drop/` carry over unchanged.

## `robot_hand`: hand the user a command

1. The agent calls `robot_hand` with a command and a one-line reason.
2. Pi shows an inline selector in place of the prompt, with the reason and exactly what you would run.
3. You pick one:
   - **Put it in my prompt**: a shell command lands as `! command`, a pi slash command such as `/reload` lands as-is. Pressing Enter runs it; a `!` command's output returns to the conversation and the agent answers it.
   - **Copy it to the clipboard**: the raw shell command, for another terminal.
   - **Type it into a new Herdr pane (I press Enter)**: when pi runs inside [Herdr](https://herdr.dev), a pane opens below pi with the command on an editable line. Edit it if needed and press Enter, or Ctrl+C to cancel.
   - **Run it in a new Herdr pane**: the same pane, with the command started at once.
   - **No, thanks**: nothing is placed.
4. The tool returns the choice. After a hand-over the agent's turn ends, so the next move is yours.

A Herdr pane is a real terminal, so password prompts, `sudo`, confirmations, `ssh`, and full-screen programs work there; pi's `!` has no terminal input. When the command finishes, the pane closes and its output (the last 200 lines) and exit code arrive as a message that starts the agent's next turn. Cancelling, or closing the pane yourself, also reports back.

```
 robot_hand 需要 sudo 重啟服務
   ! sudo systemctl restart nginx
 ──────────────────────────────────────────────
 Robot Hand — 需要 sudo 重啟服務

   ! sudo systemctl restart nginx

 → Type it into a new Herdr pane (I press Enter)
   Put it in my prompt
   Copy it to the clipboard
   Run it in a new Herdr pane
   No, thanks

 ↑↓ navigate  enter select  escape/ctrl+c cancel
 ──────────────────────────────────────────────
```

| Parameter | Description |
|---|---|
| `command` | The command. Shell commands go without a leading `!`; pi commands start with `/`. |
| `reason` | One short line telling the user why, in the user's language. |
| `kind` | `shell` (default) or `pi`. |
| `default` | The option the selector starts on: `prompt` (default), `clipboard`, `herdr-type`, or `herdr-run`. The agent picks `herdr-type` for commands that need terminal input. An option this session cannot offer falls back along `herdr-run` → `herdr-type` → `clipboard` → `prompt`. |

When the prompt already holds a draft, the prompt option says it replaces the draft. The clipboard and Herdr options appear only for shell commands in the terminal UI, and the Herdr options only inside Herdr. RPC clients get the prompt option; modes without a UI make the tool fail so the agent shows the command in chat.

The Herdr pane runs a short wrapper script (zsh, or bash 4+ when zsh is missing) from a private temporary directory, which is removed when the run is reported. The command runs in a non-interactive shell, so your shell aliases and functions are not loaded.

## `!` follow-up

Pi records the output of a `!command` but does not start a turn. With pi-robot-hand, once a `!command` typed while the agent is idle finishes, the agent reads its output and answers. Pi still runs the command, so output streams live and other `user_bash` extensions keep working. `!!` commands, cancelled commands, commands typed while the agent is busy, and commands overtaken by a prompt you send meanwhile keep pi's behavior.

## `secret_drop`: put a secret in without the agent seeing it

1. The agent calls `secret_drop` with a destination, a placement, and the steps to get the secret.
2. Pi opens a masked dialog that shows those steps, where the value will go, and what happens next. The user types or pastes the secret, or presses Tab to ask the agent a question instead.
3. The value is staged in `~/.pi/agent/secret-drop/staging/` (mode 600), and pi pre-fills a `!` command in the user's prompt:

   ```
   ! node ~/.pi/agent/npm/node_modules/pi-robot-hand/dist/apply.js env ./.env DB_PASSWORD --from ~/.pi/agent/secret-drop/staging/64770-948e1cb74b5a
   ```

4. The user reviews it and presses Enter. The apply script writes the destination, deletes the staged file, and prints only a report:

   ```
   ✓ secret-drop: updated DB_PASSWORD (1 line) in ./.env (env DB_PASSWORD, mode 644) — length check passed (28 chars)
   ```

5. The tool, which has been waiting, returns that report and the agent continues.

The agent never opens the destination: the user runs the write with a command they can read. That also keeps secret-guarding extensions such as [cc-safety-net](https://github.com/kenryu42/cc-safety-net) in charge of the agent's tool calls, since pi's `!` commands are the user's own.

```
╭─ Secret Drop ──────────────────────────────────────────────────────────────╮
│ Staging database password                                                  │
│                                                                            │
│ How to get it                                                              │
│ 1. Open the staging project in 1Password                                   │
│ 2. Copy the password of the "db-staging" item                              │
│                                                                            │
│ Goes to  ./.env (env DB_PASSWORD)                                          │
│ Next     Enter here stages the value. Your prompt then holds a ! command;  │
│          press Enter on it to apply. The agent never sees the value.       │
│                                                                            │
│ › ••••••••••••••••••••••••••••                                             │
│   28 chars                                                                 │
│                                                                            │
│ Enter stage · Tab ask a question instead · Esc cancel · Ctrl+R show/hide · │
│ Ctrl+U clear                                                               │
│ Stuck or unsure? Press Tab and ask; the dialog closes and the agent        │
│ answers.                                                                   │
╰────────────────────────────────────────────────────────────────────────────╯
```

Tab opens a visible question field. Enter there closes the dialog without staging anything, discards what was typed in the secret field, and returns the question to the agent, which answers and calls `secret_drop` again. When the steps do not fit the terminal, the dialog shortens them; the tool call in the chat shows them in full.

### With cc-safety-net

The two cover different halves of the problem:

- **cc-safety-net keeps the agent out of secrets that already exist.** It blocks the agent's shell and file tools from reading `.env` files, SSH keys, `~/.aws`, and other well-known credential locations, whether or not secret_drop wrote them.
- **secret_drop gets new secrets in without the agent seeing them.** It protects the destinations it writes, including files outside cc-safety-net's patterns such as `config.yml`, and redacts the values from tool output.

They do not conflict. cc-safety-net inspects the agent's tool calls; the apply command is the user's own `!` command, so the write goes through while the agent stays blocked from reading the result.

### Parameters

| Parameter | Meaning |
|---|---|
| `label` | What the user should enter, in the user's language. |
| `instructions` | Required. Numbered steps, in the user's language: where to go (URL or menu path), what to fill in, and what to copy. One step for a value the user already knows. |
| `url` | The page where the user creates or finds the secret. |
| `format` | `env`, `regex`, `file`, or `command`. Defaults to `env` when `key` is set, `command` when `command` is set, else `file`. |
| `destination` | `env` / `regex` / `file`: target file, relative to the working directory. Missing directories are created. |
| `key`, `quote` | `env`: variable name and quoting (`auto`, `none`, `single`, `double`). Existing `KEY=` / `export KEY=` lines are replaced, keeping trailing `# comments` and CRLF endings; otherwise the line is appended. Use `none` for files read by `docker --env-file`, which keeps quotes as part of the value. |
| `regex`, `flags` | `regex`: replaces capture group 1, or the whole match, in an existing file. `g` replaces every match. |
| `fileMode` | Octal permissions. New files default to `600`; existing files keep their mode. |
| `overwrite` | `file`: allow replacing an existing destination, for rotating single-value files such as keys. Without it an existing destination is refused; with it the dialog warns in red. |
| `command` | `command`: shell command reading the staged file `{secret}`, e.g. `ansible-vault encrypt_string --stdin-name db_password < {secret} >> vault.yml`. Stdout is discarded; stderr is shown with the value redacted when the command fails. |

Writes are atomic (temp file + rename) and verified by re-reading the destination. When verification fails, the original content and mode are restored from memory (a newly created file is removed); no backup file is written, so no copy of a secret is left outside the protected destination. The staged file is overwritten and deleted after every apply attempt, and when the tool is cancelled or aborted. Staged files left by pi processes that have exited are removed at session start.

### Protection after the write

- **Blocked reads.** `read`, `edit`, `write`, and `grep` on a destination or the staging area are blocked. In bash, each simple command is checked on its own: it is blocked when a protected path is an argument of a command that prints, copies, or opens files (`cat`, `head`, `grep`, `sed`, `cp`, `base64`, …, also behind `sudo`, `env`, `timeout`, `xargs`), a `<` or `>` redirection target, or inside `sh -c`, `eval`, `$(…)`, or backticks. Commands that only pass the path to a consumer, such as `--env-file .env` or `test -s .env`, still run.
- **Redaction.** Any tool result or context message containing a secret value is rewritten to `[REDACTED]`. Values are reloaded from protected destinations at session start.
- **Registry.** Protected locations (never values) live in `~/.pi/agent/secret-drop/registry.json`. `/secret-drop` lists them; `/secret-drop forget <path>` removes one.

### Limits

- Requires the interactive terminal UI. In RPC, JSON, and print modes the tool fails instead of falling back to a plain-text prompt.
- The dialog is a centered overlay, which pi-tui cannot draw over rows holding terminal images. Set `PI_ASK_USER_DISPLAY_MODE=inline` (the variable pi-ask-user reads) in the shell that launches pi to render it inline instead.
- The bash guard parses command lines, not programs. It stops accidental reads, not a determined agent: an indirect path (a variable, a glob, a script or `python -c` that prints the file) passes through. Redaction is the second layer for that output.
- The rename replaces the destination's inode: hard links to it break and the file becomes owned by the user who runs the apply command. Symlinks are resolved and kept.
- A multi-line quoted `KEY="…` value is replaced on its first line only.
- Values shorter than 4 characters are not redacted. Values applied with `format: "command"` are redacted for the rest of the session only.
- The apply command is shown before it runs; review it, since a `command` can send the staged value anywhere.

## `robot_hand` and CC Safety Net

CC Safety Net 2.4.7 scans tool input for sensitive paths, so it may block `robot_hand` when the *text* of a command names one. `robot_hand` only displays the command; the user decides whether to run it.

Use a CC Safety Net build containing the Pi `robot_hand` display-only exemption (the local `fix/pi-allow-display-only-tools` branch; **not** the published 2.4.7 release). It applies only to the exact Pi tool name `robot_hand`; `bash` and other tools stay protected. To check it, ask the agent to hand over a harmless command containing a dummy sensitive-path name, such as `.env.agent-8091`: the selector should open without a CC Safety Net block. Do not press Enter to run a command you do not want to execute.

## Development

```bash
npm install
npm run check   # tsc --noEmit
npm test        # builds dist/, then node --test
```

`lib/` holds the secret placement and write logic shared by the extension and the apply script. The extension imports it as TypeScript, so pi's `/reload` picks up an upgrade; Node caches `.js` and `.mjs` modules for the life of the process. `npm run build` compiles `lib/` to `dist/` for the apply script, which runs with plain `node` because Node does not strip TypeScript types under `node_modules`. `npm pack` and `npm publish` build first.

Releases publish from GitHub Actions through npm trusted publishing: bump `version` in `package.json`, commit, and push a matching `v<version>` tag.

## License

MIT
