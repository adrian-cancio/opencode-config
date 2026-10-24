---
name: agent-delivery
description: Use when implementing or coordinating multi-step changes. Deliver bounded increments with observable acceptance and proportionate verification.
---

# Agent Delivery

Use with the global and project instructions, not as a replacement for them. This workflow applies on any supported host and with or without an orchestrator. Use the project's actual tools and platform; do not assume a shell, package manager, service, model, or local path.

## Procedure

1. **Establish the baseline.** Inspect applicable instructions, working-tree changes, relevant entrypoints, contracts, and project-native checks. Record relevant existing failures without altering other work. Exit: known scope and initial state.
2. **Define acceptance.** Identify the required behavior, examples, failure cases, compatibility constraints, and excluded changes. Investigate facts in the repository before asking questions. Ask only about unresolved choices that affect the intended result or authorization. Exit: observable acceptance, not adjectives such as "professional" or "robust".
3. **Choose the smallest adequate approach.** Consider correctness, project fit, risk, reversibility, and maintenance cost. Resolve consequential uncertainty with a bounded probe before building around an assumption. Explain significant decisions briefly; do not require a formal plan for a trivial edit. Exit: a justified, proportionate approach.
4. **Implement a verifiable increment.** For a reproducible bug, show a relevant regression test failing for the intended reason before the fix when feasible. Derive expected results from requirements or an independent reference, not merely the generated implementation. Keep unrelated refactoring, translations, dependencies, and cleanup out of the diff. Exit: a coherent change within scope.
5. **Exercise the relevant path.** Run focused checks, then broader gates when the impact warrants them. Check real behavior where mocks cannot establish the property: rendered UI, actual integration, packaged artifact, or measured performance. Use isolated data and authorized environments. If the real target is unavailable, report the precise gap rather than claiming success. Exit: evidence mapped to acceptance criteria.
6. **Review and repair.** Inspect the final diff, unintended files, error paths, and test strength. Use independent review when warranted; require concrete evidence and reproduce findings before accepting them. Repair your own regressions and rerun affected checks. Exit: resolved findings or explicitly disclosed residual risk.
7. **Close or hand off honestly.** Report changes, checks and actual results, unverified behavior, and blockers. Update documentation made stale by this change. Commit, publish, deploy, or change external state only under applicable authorization. If interrupted, leave a short handoff naming current state, evidence, and the next step. Exit: an assessable deliverable, not a promise of later work.

## Recovery And Stop Conditions

- On failure, inspect the error and partial artifacts before retrying. Retry only with new evidence, a changed hypothesis, or a justified transient-failure policy.
- If scope must expand, state why, what would change, and the smallest alternative. Do not silently redesign the project.
- Stop overlapping writes when ownership is uncertain. Do not fix that uncertainty by resetting or stashing the working tree.
- Stop before an unapproved destructive, paid, sensitive-data, or external action. Never bypass an approval through another tool or shell.
- If blocked, finish with the blocker, completed work, exact missing verification, and the minimum decision or access needed. A failed command does not excuse omitting the final report.

## Verification Standard

Classify checks as **passed**, **failed**, or **not run/blocked**. Name the command or procedure and relevant outcome. Compilation does not prove runtime behavior; a mock does not prove an external integration; two agents agreeing does not prove correctness. Scale verification to the risk and state what the evidence does and does not establish.
