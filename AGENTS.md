# Global OpenCode Instructions

This global OpenCode setup includes several MCPs. Prefer them when they fit the task.

- `github`: use for repositories, issues, pull requests, review comments, checks, releases, and GitHub code search.
- `context7`: use for up-to-date framework and library documentation before falling back to generic web research.
- `browsermcp`: use for real browser workflows, rendered pages, screenshots, and UI debugging. It requires the Browser MCP extension and a connected tab.
- `docker`: use for local container inspection, logs, stats, exec, restarts, and image/container management.
- `brave-search`: if enabled in the current session, use it for fresh web, news, image, video, and LLM-context search.

Working guidance:

- Prefer `context7` over generic web fetches for library/framework usage questions.
- Prefer `github` for GitHub-hosted context instead of scraping pages manually.
- Prefer `browsermcp` when the task depends on real browser state or rendered UI behavior.
- Prefer `docker` for containerized services instead of inferring runtime state from files alone.
- If `brave-search` is unavailable or disabled, continue with native OpenCode tools such as `webfetch`.
