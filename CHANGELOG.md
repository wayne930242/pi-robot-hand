# Changelog

## Unreleased

- `secret_drop` guidance: when a secret is created or revealed on a web page and the agent can drive the user's signed-in browser, the agent first asks whether to prepare that page up to its final create or reveal button, so the user only presses it and copies the value. The agent leaves that tab unread until the value is applied.

## 0.3.0

- `robot_hand` becomes a dialog owner of dialog contract v1: it publishes `robot-hand:pending` for the selector it opens and accepts one validated `robot-hand:answer` from another extension, replying with `robot-hand:answer-result` and `robot-hand:closed`. See "Answering from another extension" in the README.
- A remotely answered call returns the same result text as a terminal pick; `details.answeredFrom` is `"browser"`.
- Terminal behavior is unchanged. `secret_drop` publishes nothing.

## 0.2.2 and earlier

See the git history.
