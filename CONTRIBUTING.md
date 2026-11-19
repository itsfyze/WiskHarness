# Contributing

Use an isolated WiskHarness profile and disposable workspace for changes and tests. Install Windows x64 dependencies with `npm ci`, then run `npm run check` and `npm test`.

Keep Plan tool-free. Permission, process termination, rollback and update changes should have tests that verify the observable result. For UI changes, include the affected window size, theme and keyboard interaction in the verification notes.

Use small commits. Keep sessions, logs, model data, backup directories, private configuration and build artifacts out of Git. Changes to licensing or release automation require separate review by the maintainer.
