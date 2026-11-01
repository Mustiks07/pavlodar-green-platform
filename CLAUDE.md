# Claude project entry point

Read and follow `AGENTS.md` first. It is the shared instruction source for both agents.
Then read `docs/TZ_DEVELOPMENT.txt`, `docs/TEAM_PROTOCOL.txt`, and
`prompts/CLAUDE_START.txt`.

Use the same repository, API schemas, fixtures and acceptance criteria as GPT.
You own the web client, map and 3D interaction; the backend owns authoritative numbers.
Generate the client types from `contracts/openapi.json`; do not invent alternate DTOs.
Use a separate worktree/clone and task branch. Before remote writes, verify that the
authenticated GitHub account is Mustiks07 and the local commit identity matches AGENTS.md.

Do not implement the entire app against permanent fake endpoints. Test fixtures may
unblock isolated UI development, but the real persisted API is required for integration.
Review the baseline specification and propose concrete improvements via an ADR/contract
change instead of silently replacing the agreed stack or removing product capabilities.
