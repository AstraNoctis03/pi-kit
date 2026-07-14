---
name: code-review
description: Reviews diffs, pull requests, and source files for correctness, security, type safety, and maintainability. Use when evaluating code changes before delivery.
---

# Code Review

1. Establish the review scope and intended behavior.
2. Trace affected call paths and data flow.
3. Check correctness, edge cases, error handling, concurrency, types, security, and tests.
4. Report only actionable findings, ordered by severity.

For each finding, cite an exact file and line when available, explain the impact, and suggest a concrete fix. Separate confirmed defects from questions and testing gaps. Do not inflate style preferences into findings.
