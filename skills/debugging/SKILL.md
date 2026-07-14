---
name: debugging
description: Diagnoses runtime errors, failing tests, build failures, and unexpected behavior through evidence-driven root-cause analysis. Use when investigating or fixing a reproducible defect.
---

# Debugging

1. Reproduce the failure and record its conditions.
2. Narrow the scope using logs, stack traces, recent changes, and focused commands.
3. Form one evidence-based hypothesis at a time and test it with the smallest useful experiment.
4. Fix the root cause rather than masking the symptom.
5. Run the focused proof test and remove temporary diagnostics.

Never delete failing tests, suppress type errors, swallow exceptions, or apply speculative fixes. After three failed hypotheses, summarize the evidence and request the missing information.
