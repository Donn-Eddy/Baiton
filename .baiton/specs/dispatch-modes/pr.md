# pr result

```json
{
  "title": "Add mode-specific run pipelines",
  "body": "## What changed\n\n- Add five conversation modes: the unchanged default Spec mode plus Bug, Quick, Refactor, and read-only Investigate.\n- Add run manifests, run-scoped artifacts, isolated worktrees and branches, lifecycle controls, guarded merge behavior, and a plan → execute → review pipeline for spec-less modes.\n- Add run-phase orchestration tools, mode-aware prompts and briefs, confirmation cards, busy-state coordination, and Investigate findings that can be promoted to Bug or Quick work.\n- Add a host-authoritative Mode control in chat and a Runs explorer with Cancel, View diff, and Merge actions.\n- Extend Git and launcher primitives for worktree-aware execution, add comprehensive unit/integration coverage, and document the new workflows.\n\n## Why\n\nUsers can now route work through an appropriate pipeline without creating a Spec for every request. Non-Spec work remains isolated from `.baiton/specs/`, while Investigate can produce actionable findings without changing the repository.\n\n## Verification\n\n- `npm run compile`\n- `npm run lint`\n- `npm test`\n- Targeted Mocha coverage for run storage, worktree lifecycle, run pipeline, command handling, chat mode behavior, and the end-to-end run-mode workflow."
}
```
