# Development

This is a Pi extension. Read Pi's `docs/extensions.md` and `docs/packages.md` before changing its runtime or package structure.

## Checks

```sh
npm ci
npm run check
npm pack --dry-run
```

`./setup.sh` activates the repository Git hooks. The pre-commit hook runs the test and type checks. The pre-push hook stops a stale `main` push after the release workflow advances the remote branch.

## Manual behavior test

Start an isolated Pi process with this extension:

```sh
pi --no-extensions -e .
```

Use a model with a known context window. Cross a threshold through a tool result and verify one notification appears. Repeat with compaction before the next model request and verify no stale notification appears.

## Release process

GitHub Actions runs the checks on every push and pull request. A push to `main` creates a patch release, publishes it to npm, mirrors it to GitHub Packages, and creates a GitHub release.

The npm package uses trusted publishing. Configure `giladbarnea/pi-context-auto-heads-up` and `.github/workflows/publish.yml` as the npm trusted publisher before enabling automatic releases.

## Maintainer coupling

`~/.claude/hooks/context_heads_up.py` mirrors the thresholds, wording, and once-per-crossing behavior for Claude Code. Keep that shared contract aligned. The runtime hooks differ between the two harnesses.
