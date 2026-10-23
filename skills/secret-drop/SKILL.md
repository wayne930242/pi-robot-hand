---
name: secret-drop
description: Use when a password, token, API key, certificate, or other credential must be written to a file or fed to a command, or when working with a file that holds one.
---

# Secret Drop

Secrets reach files and commands through the `secret_drop` tool, so the value never enters the conversation. The user follows the steps you give, types it into a masked dialog or asks you a question instead; it is staged outside the project; pi pre-fills a `!` apply command in the user's prompt; the user runs it. The tool waits for that run and returns the apply script's report: what changed and a length check. Files that hold secrets are opaque to the agent: programs consume them, the agent never reads them.

## Writing a secret

1. Pick the destination the consuming program expects. For a `regex` placement in a file that is not yet protected, read its structure first.
2. When the value is newly created on a web page and a browser session on the user's signed-in profile is already open to you, ask the user with your question tool whether you should prepare that page; starting a browser only to qualify does not count. When they agree, open it, fill in every field (name, scope, permissions, expiration), and stop at the button that creates the value. From then on make no browser tool call in that session, whatever `secret_drop` returns, until the user has closed that tab: browser tools return page content, and the value is on that page once the button is pressed. Learn that the tab is closed from the user, through your question tool, rather than from a browser call. A page that shows an existing secret already holds the value in its DOM, so give its `url` and steps instead of opening it. When the user declines or no such session is open, write the full steps.
3. Call `secret_drop` with a `label` naming exactly what to enter (service, account, environment), `instructions` the user can follow without asking (the exact page or menu path, every field to fill in such as name, scope, permissions, and expiration, and what to copy; for a prepared page, the tab, the button to press, what to copy, and closing the tab afterwards), the page as `url` when there is one, both in the user's language, and one format:
   - `key` + `destination` (format `env`): sets `KEY=value`, replacing existing `KEY` / `export KEY` lines or appending one. Other lines and trailing comments stay. For a file read by `docker --env-file`, pass `quote: "none"`, since Docker keeps quotes as part of the value.
   - `format: "regex"` + `destination` + `regex`: replaces capture group 1, or the whole match, in an existing file. Make the group cover only the value, e.g. `password: "([^"]*)"`.
   - `format: "file"` + `destination`: the whole file is the secret, for key files and single-value files. An existing destination is refused unless `overwrite: true` is passed; pass it only to rotate a single-value file, never for a multi-value file such as `.env`.
   - `command` (format `command`): a shell command that reads the staged file `{secret}`. Redirect results into files; stdout is discarded. Examples:
     - `ansible-vault encrypt_string --vault-password-file .vault-pass --stdin-name db_password < {secret} >> group_vars/prod/vault.yml`
     - `gh secret set DEPLOY_TOKEN < {secret}`
     - `kubectl create secret generic app-tls --from-file=tls.key={secret}`
4. Call it once per secret and wait for the result:
   - **Applied**: the report states the change and `length check passed (N chars)`. That report is the verification; the value is in place.
   - **Question**: the user pressed Tab and asked instead; nothing was staged. Answer it, then call `secret_drop` again.
   - **Cancelled or aborted**: nothing was applied. Ask the user how to proceed; have the user revoke a token created on a prepared page that was not applied.
   - **Apply failed**: the staged value was discarded. Fix the parameters from the error (a regex that does not match, a failing command) and call again.

When the user offers to paste a secret into chat, call `secret_drop` instead.

## Using a file that holds a secret

Let the program that needs the secret read the file itself: a script that loads `.env` internally, a `--env-file` or `--vault-password-file` flag, or a config path. Once `secret_drop` applies a secret, `read`, `edit`, `write`, `grep`, and bash commands that print or copy the destination are blocked, and tool output containing the value shows `[REDACTED]`. Other safety extensions block secret files such as `.env` too. When a consuming command is blocked, ask the user to run it with `!`, and continue from its output.

To change a value, call `secret_drop` again with the same destination and placement. When non-secret lines in a protected file need edits, ask the user to make them.
