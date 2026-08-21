---
name: "dcp"
description: "Save this chat session to chat_history/, then commit and push everything to GitHub. Use when the user says to save/export the chat and push updates (e.g. \"/dcp\", \"save this chat and push to github\")."
---

# dcp — document, commit, push

Run these two steps in order, in `${CLAUDE_PROJECT_DIR}`.

## 1. Save the chat transcript

Get a timestamp for the filename:

```bash
date +%d%m%y%H%M
```

Write the **entire current conversation** (from its start through this /dcp invocation) to a new file at:

`${CLAUDE_PROJECT_DIR}/chat_history/<timestamp>_chat_history.txt`

where `<timestamp>` is the `ddMMyyHHmm` value from the command above (day, month, 2-digit year, hour, minute — no separators). This naming convention (`ddMMyyHHmm_chat_history.txt`) replaced an earlier `ddMMyy_chat_history.txt` convention — always use the full `ddMMyyHHmm` form for new files, even if older files in the folder use the shorter form.

If `chat_history/` doesn't exist yet, create it. Look at any existing files already in `chat_history/` first and match their format/tone. If none exist, use this structure:

```
================================================================================
CHAT HISTORY EXPORT — <YYYY-MM-DD>
Session: <one-line description of what this session was about>
================================================================================

NOTE ON REDACTIONS: <only include this paragraph if the session actually
involved a live secret/credential/token pasted into the chat; describe what
was redacted and why. Omit the whole paragraph entirely if nothing needed
redacting — don't imply redactions happened when they didn't.>

--------------------------------------------------------------------------------
USER:
<summarize the user's message(s) — condense long instructions to their
substance, but keep specifics like file paths, numbers, and decisions intact>

--------------------------------------------------------------------------------
ASSISTANT:
<summarize what was actually done: key findings, tool calls and their outcomes,
questions asked and the answers given, files changed, anything published or
pushed. Write it as narrative prose, not a transcript dump — condense large
tool outputs to their substantive findings rather than reproducing them
verbatim. Preserve the back-and-forth order.>

--------------------------------------------------------------------------------
<continue alternating USER / ASSISTANT sections, separated by the dashed rule,
for the rest of the session>

================================================================================
END OF EXPORT
================================================================================
```

Before writing, scan the session for anything that must never be committed to a (potentially public) repo: API keys, tokens, passwords, private keys, connection strings pasted directly in chat. Replace each with a `[REDACTED_*]` placeholder and note it in the redactions paragraph. Never write a real secret into the file.

## 2. Commit and push

From `${CLAUDE_PROJECT_DIR}`:

1. Run `git status` and review it — confirm this is a git repo with a remote configured (`git remote -v`). If either is missing, stop and tell the user rather than initializing a repo or adding a remote on their behalf.
2. Check what's about to be staged. If anything looks like a live credential or an obviously sensitive file that isn't already `.gitignore`d, flag it to the user before staging it — don't silently commit it.
3. Stage all legitimate changes (the new chat-history file plus any other outstanding changes in the working tree), commit with a concise message describing what changed in this session, and push to the current branch's remote (`origin`, typically `main` — check `git branch --show-current` rather than assuming).
4. Report back: the chat-history file path, the commit hash/message, and confirmation the push succeeded (or what went wrong, if it didn't).

Do not use `--force`, `--no-verify`, or skip hooks. If a pre-commit hook fails, fix the underlying issue and make a new commit rather than bypassing it.
