# Changelog

## 0.5.3

- The `e` check counts answers given in dialog tools as the user's, not only `secret_drop` replies: `ask_user_question` and `ask_user` are built in, and `dialogTools` (a list of tool names) in `~/.pi/agent/robot-hand.json` adds more. A dialog tool's details go to the checker whole, without parsing its format; each string field is redacted first and cut to 300 characters (start and end), the record to 1,500, and all answers to the latest 6,000. The checker is told that only what the user typed or picked is theirs; questions, option labels, previews, commands, and reports were written by the agent or the tool. Other tools' details stay out.

## 0.5.2

- The check's model list puts the provider pi is using now first. pi lists every model of a provider that has a stored credential, even an expired one, so a provider whose check failed is marked `(sign-in failed)` or `(check failed)` and moved to the end for the rest of the session; a successful check clears the mark. The filter line reads `Filter:`.

## 0.5.1

- The `e` check reads a reply the user typed into `secret_drop`'s dialog from the tool's details, not its text, and lists it as the user's; the rest of what happened after the user's last message goes to the checker fenced and marked untrusted, and cannot change the user's request. Before, tool output could imitate a user reply and turn a mismatch into a match.
- Secret values are redacted before any text is cut (the user's message, the log, replies, scripts), so a secret that straddled a cut no longer reaches the checker in part.

## 0.5.0

- `robot_hand`: press `e` in the terminal selector to have another model check the command. It reads the command, the scripts the command runs (files with a script extension or a `#!` line, up to five, 16 KB each; files `secret_drop` protects and its staging folder are never read), the agent's reason, the user's last message, and what happened after it (agent text and tool results, up to 2,000 characters, so a reply given inside `secret_drop` or a question dialog counts), and shows what the command will do and whether that matches: match, partial, mismatch, or unclear. The first `e`, and the next one after a failed check, asks which signed-in model to use; `E` always asks. The choice is saved as `checkModel` in `~/.pi/agent/robot-hand.json`. Known `secret_drop` values in the command, scripts, reason, and message are replaced with `[REDACTED]` before sending; an unreadable or unknown secret_drop registry fails the check and sends nothing. Command and script text go to the checker fenced, marked as data. The checker answers in the language of the user's last message, or of the reason when there is none. Starting a new check aborts the one still running. The check never blocks a choice; when the user checked, the tool result carries the verdict and `details.check`. In the terminal UI the selector is now robot_hand's own component (↑↓ or j/k, stopping at the ends as before); `app.tools.expand` does not work while it is open. RPC clients keep pi's selector and get no check. The dialog contract (title, labels, digest) is unchanged.
- `secret_drop`: Tab now opens a reply instead of a question. The user can ask a question or leave a note such as where the secret already is. The result tells the agent to answer a question and call again, or to use the stated location without reading the value and not ask again. A location the user names in a note is not guarded like a destination `secret_drop` wrote; the result and docs say so. `details.status` is `"reply"` (was `"question"`).

## 0.4.0

- The two Herdr pane choices now carry `next: "pane"` and `tagged: true` in `robot-hand:pending`, and "Put it in my prompt" carries `next: "terminal"` (hints, not hashed). When another extension's answer picks a pane choice, the new pane is marked with `herdr pane report-metadata <pane_id> --source robot-hand --token sb_answer=<answerId> --ttl-ms 600000` right after the split and before the command is typed or run, so Straw Boss grants its terminal keys to that pane and no other. Tagging is tried once; a failure does not stop the command. A pick in the terminal tags nothing.

## 0.3.2

- Tighter browser preparation for `secret_drop`: only pages that newly create a secret are prepared, and only in a browser session already open on the user's signed-in profile. After preparing, the agent makes no browser call in that session until the user says the tab is closed, whatever `secret_drop` returns, because browser tools return page content. Pages that show an existing secret are never opened by the agent, since the value is already in their DOM. A token created on a prepared page and not applied is revoked.

## 0.3.1

- `secret_drop` guidance: when a secret is created or revealed on a web page and the agent can drive the user's signed-in browser, the agent first asks whether to prepare that page up to its final create or reveal button, so the user only presses it and copies the value. The agent leaves that tab unread until the value is applied.

## 0.3.0

- `robot_hand` becomes a dialog owner of dialog contract v1: it publishes `robot-hand:pending` for the selector it opens and accepts one validated `robot-hand:answer` from another extension, replying with `robot-hand:answer-result` and `robot-hand:closed`. See "Answering from another extension" in the README.
- A remotely answered call returns the same result text as a terminal pick; `details.answeredFrom` is `"browser"`.
- Terminal behavior is unchanged. `secret_drop` publishes nothing.

## 0.2.2 and earlier

See the git history.
