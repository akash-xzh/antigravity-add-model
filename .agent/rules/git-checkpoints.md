---
trigger: always_on
---

# Mandatory Git Checkpoints Rule

Every coding agent working in this repository MUST maintain clean git checkpoints so the user can always track progress and roll back safely:

1. **Pre-edit safety check**: Before making non-trivial edits, run `git status`. If there are already verified uncommitted changes from a prior task, commit them as a checkpoint first.
2. **Post-edit checkpoint commit**: After finishing any code change and verifying it (`npm run build` + relevant tests passing), **always create a git commit** with a clear, descriptive message (e.g., `fix(proxy): authenticate MITM /main.js redirect`) before concluding your turn.
3. **Clean staging**: Stage only intended source, test, config, doc, and build files. Never commit secrets, logs, or temporary scratch files (`scratch/`, `HERMES_UNDO_REVIEW.md`, `*.log`).
4. **Remote policy**:
   - `myfork` (`https://github.com/akash-xzh/antigravity-add-model.git`) is the user's writable remote.
   - `origin` (`https://github.com/vahapogut/antigravity-add-model.git`) is upstream read-only.
   - Push to `myfork` only when the user asks, and never force-push `main`.
