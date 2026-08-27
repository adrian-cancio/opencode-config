---
name: performance-optimization
description: Performance optimization workflow. Use when profiling, measuring, or optimizing CPU, memory, render times, network requests, or I/O bottlenecks.
---

# Performance Optimization

Use this skill when asked to optimize application performance, reduce latency, or eliminate bottlenecks.

## Workflow

1. Measure first: establish a baseline metric before making any changes.
2. Isolate the bottleneck using evidence (profiling, logs, timers, network inspection) instead of guessing.
3. Propose the minimal targeted optimization (e.g. caching, query optimization, lazy loading, memory allocation reduction).
4. Apply the change and re-measure against the baseline.
5. Confirm functional correctness and lack of side-effects.

## Output

Return:
- baseline vs. post-optimization metrics
- root cause of the bottleneck
- changes applied
- trade-offs or residual considerations
