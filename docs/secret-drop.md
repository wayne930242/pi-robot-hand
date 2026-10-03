# secret_drop reference

How `secret_drop` places a secret, what it protects afterwards, and its limits.
The overview is in the [README](../README.md#secret_drop-put-a-secret-in-without-the-agent-seeing-it).

## Parameters

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

## Writes

Writes are atomic (temp file + rename) and verified by re-reading the destination. When verification fails, the original content and mode are restored from memory (a newly created file is removed); no backup file is written, so no copy of a secret is left outside the protected destination. The staged file is overwritten and deleted after every apply attempt, and when the tool is cancelled or aborted. Staged files left by pi processes that have exited are removed at session start.

## Protection after the write

- **Blocked reads.** `read`, `edit`, `write`, and `grep` on a destination or the staging area are blocked. In bash, each simple command is checked on its own: it is blocked when a protected path is an argument of a command that prints, copies, or opens files (`cat`, `head`, `grep`, `sed`, `cp`, `base64`, …, also behind `sudo`, `env`, `timeout`, `xargs`), a `<` or `>` redirection target, or inside `sh -c`, `eval`, `$(…)`, or backticks. Commands that only pass the path to a consumer, such as `--env-file .env` or `test -s .env`, still run.
- **Redaction.** Any tool result or context message containing a secret value is rewritten to `[REDACTED]`. Values are reloaded from protected destinations at session start.
- **Registry.** Protected locations (never values) live in `~/.pi/agent/secret-drop/registry.json`. `/secret-drop` lists them; `/secret-drop forget <path>` removes one.

## Limits

- Requires the interactive terminal UI. In RPC, JSON, and print modes the tool fails instead of falling back to a plain-text prompt.
- The dialog is a centered overlay, which pi-tui cannot draw over rows holding terminal images. Set `PI_ASK_USER_DISPLAY_MODE=inline` (the variable pi-ask-user reads) in the shell that launches pi to render it inline instead.
- The bash guard parses command lines, not programs. It stops accidental reads, not a determined agent: an indirect path (a variable, a glob, a script or `python -c` that prints the file) passes through. Redaction is the second layer for that output.
- The rename replaces the destination's inode: hard links to it break and the file becomes owned by the user who runs the apply command. Symlinks are resolved and kept.
- A multi-line quoted `KEY="…` value is replaced on its first line only.
- Values shorter than 4 characters are not redacted. Values applied with `format: "command"` are redacted for the rest of the session only.
- The apply command is shown before it runs; review it, since a `command` can send the staged value anywhere.
