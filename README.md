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

Not sure what the command does? Press `e` in the selector and another model reads the command, the scripts it runs (see below; files `secret_drop` protects are never read), the agent's reason, your last message, what you answered since in a dialog tool (`secret_drop`, `ask_user_question`, `ask_user`, and any tool named in `dialogTools` in `~/.pi/agent/robot-hand.json`; their records go over whole, each field redacted and cut to its start and end), and a short log of what happened after your message (marked untrusted), then says, in your language, what it will really do and whether that matches:

```
 ✗ Does not match the stated intent — anthropic/claude-haiku-5-5
 Deletes /var/www, then restarts nginx.
 The reason says it only restarts nginx; the script also deletes the site.
```

The first `e` asks which signed-in model to use and remembers it in `~/.pi/agent/robot-hand.json`; after a failed check, `e` asks again, and `E` always does.
The list shows every model of each provider pi holds a credential for, even an expired one; the provider you are using comes first, and a provider whose check failed is marked and moved to the end.
Known `secret_drop` values, both those in files it wrote and those fed to a command this session, are replaced with `[REDACTED]` before anything is sent; when its registry cannot be read, the check fails and sends nothing. The check informs your choice and never blocks one. When you checked, the agent's result says which model checked and its verdict.
It needs the terminal UI.

When pi has [TypeSafe](https://typesafe.ai)'s Jev classifier (a pi with classifier models, with `TYPESAFE_API_KEY` set or TypeSafe signed in through `/login`), Jev checks the command as the selector opens, without a key press. It reads the same redacted input as `e` and answers with a verdict and its probabilities, not an explanation:

```
 ✗ Jev: Does not match the stated intent (match 0.00, partial 0.00, mismatch 1.00)
```

Set `"jevCheck": false` in `~/.pi/agent/robot-hand.json` to turn it off; it is on by default. When Jev fails, the selector says so with the HTTP status only and the choices work as before.

Both checks read the scripts the command runs, found by reading files, never by running anything: script files it names, the makefile and its includes for `make`, the `package.json` entry for `npm run`, `npm test`, `pnpm`, `yarn`, and `bun run` (with npm's `pre` and `post` scripts), a module in the folder for `python -m`, and, inside shell scripts, makefile recipes, package scripts, here-documents, and `sh -c` strings, the scripts those run in turn, three levels deep. They read up to five files, 16 KB of each. Files whose names commonly hold credentials (`.env` files, shell startup files such as `.zshrc`, keys, `*.ini`, `*.conf`, names with `secret`, `token`, or `credentials`) are never sent, even when the command sources them; in everything that is sent, literal values of names such as `API_KEY` or `password`, credential options (`--token`, `curl -u`), `Authorization` headers, known token formats, private keys, and passwords in URLs become `[REDACTED]`; a masked value that may be code (a git `!` helper, a `*_COMMAND`) is listed as not followed. FIFOs and devices are never opened.
Where the scan cannot tell, it says so instead of guessing: after a `cd` that may not run (after `||`, inside `if`, a loop, `case`, a function, a pipeline, or `&`), after an `&&` list holding a `cd` ends, after `popd`, or after sourcing a file that changes folder or could not be read, the folder is unknown, and a relative script run after it is listed as not followed.
What a check cannot read, the selector lists above the verdicts, whatever the verdicts say:

```
 The checks cannot see all of what this runs:
 ⚠ Not readable: ./scripts/cleanup.sh — does not exist
 ⚠ Not followed: bash — runs code from standard input, which may be what the command downloads
 ⚠ Read in part: deploy.sh — only the first 16 KB of 48 KB were read
 ⚠ Not read: f.sh — is past the 5-file limit
```

**Not readable**: a file it runs is missing, not a regular file, a binary in the project, protected by `secret_drop`, or named like a credentials file. **Not followed**: the code comes from elsewhere: a download piped to a shell, standard input, a process substitution, a path or command name set at runtime, files matching a glob, a package `npx`, `dlx`, or `create` may download, install or lifecycle scripts (`npm install`, `npm publish`), a task runner (`just`, `rake`, `gradle`, and the like), a test or build runner (`node --test`, `pytest`, `cargo test`, `go run`, `pip install`), or git hooks the repository has. **Read in part**: a file over 16 KB. **Not read**: the five-file limit or the depth limit.
Both checks get the list. While it is not empty, neither can answer match: a match becomes partial, shown as "Matches what it read; parts it could not read", and the agent's result names what was not read.
File names, the checker's words, and the command are drawn with terminal controls, carriage returns, and bidirectional or invisible characters shown as `\u{…}` escapes, so none of them can redraw the selector; names reach the checker as JSON strings.

When either check says the command does not match, the selector adds **Report the mismatch and refuse**. It works like **No, thanks**, placing and running nothing, and also tells the agent the reason: the check found a mismatch, with each verdict. Another extension answering the selector never sees this choice.

The agent sets `default` to choose which option the selector starts on, and picks the Herdr pane for commands that need terminal input.
Options this session cannot offer are hidden: the clipboard outside the terminal UI, Herdr outside Herdr.
The pane runs the command with your `PATH` but without your `.zshrc`, so shell aliases are not available.

## `!` follow-up

Pi records a `!command`'s output but waits for your next message.
With pi-robot-hand, the agent answers as soon as the command finishes.
`!!` commands, cancelled commands, and commands typed while the agent is busy keep pi's behavior.

## `secret_drop`

1. The agent calls `secret_drop` with where the secret goes and the steps to get it.
2. You type or paste the secret into a masked dialog, or press Tab to reply to the agent instead: a question, or a note such as "it is already in `~/.config/gh/hosts.yml`". After a note, the agent is told to use that location without reading the value and not to ask again. Unlike a destination `secret_drop` wrote, that location is not guarded: reading it is not blocked and its value is not redacted.
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
| `robot-hand:pending` | owner → bus | `{ version, id, toolCallId, digest, select: { title, choices: [{ label, note?, localOnly?, next?, tagged? }], copy } }`. `id` is a random UUID for this dialog. `note` says where a choice acts; `localOnly` marks the clipboard, which is this computer's; `next` says which terminal opens once the choice is accepted (`"terminal"` for the prompt, `"pane"` for the two Herdr pane choices); `tagged: true` on a pane choice means the pane is marked as described below. `next` and `tagged` are hints and are not hashed. `copy` is the command, for a page that offers a copy button. |
| `robot-hand:answer` | bus → owner | `{ version, id, answerId, digest, selections: [index] }`. `answerId` is `[A-Za-z0-9_-]{16,64}`, minted by the answerer; `digest` is the one from `pending`; `selections` holds exactly one zero-based index into `choices`. No other keys. |
| `robot-hand:answer-result` | owner → bus | `{ version, id, answerId, accepted, reason? }`, emitted synchronously inside the `answer` listener. `reason` is `closed`, `digest`, `malformed`, or `not-allowed`. An answer for an unknown `id` gets no result. |
| `robot-hand:closed` | owner → bus | `{ version, id, by, answerId? }`, once per dialog: `by` is `local` (picked in the terminal), `remote` (with the `answerId`), `cancel` (Escape), `abort` (the agent's turn was aborted), or `error`. |

The digest is the lowercase hex SHA-256 of `JSON.stringify(["pi-dialog/1", "select", title, labels])`, where `labels` are the choice labels in order. It binds an answer to what the user saw. For the title `Robot Hand — Deploy needs your sudo password\n\n  ! npm run deploy` and the labels `Type it into a new Herdr pane (I press Enter)`, `Put it in my prompt`, `No, thanks`, the digest is `2974924308b3389b43761124fc7cbc4a4feced24e7f83706ae3f568a21b45faf`.

An answer for this dialog's `id` is refused whole unless its `version`, `answerId`, `digest`, and `selections` are right and it has no extra keys; an `answerId` that fails the pattern comes back as an empty string in the result. The first of a terminal pick, a valid answer, Escape, or an abort wins: a later answer gets `accepted: false, reason: "closed"`, and an answer sent while `pending` is being emitted wins before the selector opens. A remote answer closes the terminal selector; the tool result is the same text as a terminal pick, with `details.answeredFrom: "browser"`.

When an accepted answer picks one of the two Herdr pane choices, `robot_hand` marks the pane it just opened so the answerer can tell which pane is the owner's: right after `herdr pane split` and before anything is typed or run there, it runs `herdr pane report-metadata <pane_id> --source robot-hand --token sb_answer=<answerId> --ttl-ms 600000`. The value is exactly the answer's `answerId`. [Straw Boss](https://github.com/wayne930242/pi-straw-boss) grants its terminal keys only to the pane that carries it. The tag is set once, with no retry; if it fails, the command still runs and the answerer grants no pane. A pick in the terminal, and answers for the other choices, tag nothing.

Any extension in the pi process can read dialog ids from the bus and answer. That adds no authority: such an extension could already run commands itself, so there is no opt-in setting. `secret_drop` never publishes a dialog and can only be answered in the terminal. It does serve one bus request, `secret-drop:redact`: an extension emits `{ version: 1, text, reply }` and `secret_drop` calls `reply` during the emit with the text redacted by every value it knows this session, so values never travel on the bus. The `e` check uses it.

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
