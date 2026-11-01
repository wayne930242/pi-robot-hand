# Changelog

## Unreleased

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
