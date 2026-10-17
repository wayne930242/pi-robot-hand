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

Also on the [pi package gallery](https://pi.dev/packages/pi-robot-hand).

## `robot_hand`

The agent calls `robot_hand` with a command and a one-line reason, and pi shows a selector:

```
 Robot Hand — Restarting nginx needs sudo

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

## Answering from another extension

`robot_hand` publishes the selector it opens on pi's in-process event bus, so another extension (a browser page, a remote UI) can answer it. The terminal selector works as before whether or not anyone listens, and an answer runs exactly as if you had picked it there.

The contract is "dialog contract v1", shared by every extension that owns a dialog; only the event prefix differs. For `robot_hand` the prefix is `robot-hand`. Every payload carries `version: 1`.

| Event | Direction | Payload |
|---|---|---|
| `robot-hand:pending` | owner → bus | `{ version, id, toolCallId, digest, select: { title, choices: [{ label, note?, localOnly? }], copy } }`. `id` is a random UUID for this dialog. `note` says where a choice acts; `localOnly` marks the clipboard, which is this computer's. `copy` is the command, for a page that offers a copy button. |
| `robot-hand:answer` | bus → owner | `{ version, id, answerId, digest, selections: [index] }`. `answerId` is `[A-Za-z0-9_-]{16,64}`, minted by the answerer; `digest` is the one from `pending`; `selections` holds exactly one zero-based index into `choices`. No other keys. |
| `robot-hand:answer-result` | owner → bus | `{ version, id, answerId, accepted, reason? }`, emitted synchronously inside the `answer` listener. `reason` is `closed`, `digest`, `malformed`, or `not-allowed`. An answer for an unknown `id` gets no result. |
| `robot-hand:closed` | owner → bus | `{ version, id, by, answerId? }`, once per dialog: `by` is `local` (picked in the terminal), `remote` (with the `answerId`), `cancel` (Escape), `abort` (the agent's turn was aborted), or `error`. |

The digest is the lowercase hex SHA-256 of `JSON.stringify(["pi-dialog/1", "select", title, labels])`, where `labels` are the choice labels in order. It binds an answer to what the user saw. For the title `Robot Hand — Deploy needs your sudo password\n\n  ! npm run deploy` and the labels `Type it into a new Herdr pane (I press Enter)`, `Put it in my prompt`, `No, thanks`, the digest is `2974924308b3389b43761124fc7cbc4a4feced24e7f83706ae3f568a21b45faf`.

An answer for this dialog's `id` is refused whole unless its `version`, `answerId`, `digest`, and `selections` are right and it has no extra keys; an `answerId` that fails the pattern comes back as an empty string in the result. The first of a terminal pick, a valid answer, Escape, or an abort wins: a later answer gets `accepted: false, reason: "closed"`, and an answer sent while `pending` is being emitted wins before the selector opens. A remote answer closes the terminal selector; the tool result is the same text as a terminal pick, with `details.answeredFrom: "browser"`.

Any extension in the pi process can read dialog ids from the bus and answer. That adds no authority: such an extension could already run commands itself, so there is no opt-in setting. `secret_drop` never publishes anything and can only be answered in the terminal.

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
