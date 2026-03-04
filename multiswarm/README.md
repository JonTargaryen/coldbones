# MultiSwarm Control Plane

This folder is the operational control plane for coordinating parallel agent work across the desktop-5090 migration backlog.

## Source of truth

- `multiswarm/agents.json` — agent roster, domains, and ownership boundaries
- `multiswarm/tickets.json` — ticket states, dependencies, assignment, and history
- `multiswarm/variables.json` — shared cross-ticket variables and ownership/lock state
- `multiswarm/decisions.json` — architecture/process decisions with traceability

## CLI

Use `scripts/multiswarm.py` from repo root.

Examples:

```bash
python3 scripts/multiswarm.py status
python3 scripts/multiswarm.py ready
python3 scripts/multiswarm.py assign-suggested
python3 scripts/multiswarm.py claim CB-5090-001 inference-agent
python3 scripts/multiswarm.py set-var MODEL_RUNTIME vllm inference-agent --status locked --ticket CB-5090-001 --rationale "Production runtime decision"
python3 scripts/multiswarm.py decision CB-5090-001 inference-agent "Q4 artifact must be validated against vLLM compatibility"
python3 scripts/multiswarm.py handoff CB-5090-004 api-agent frontend-agent --note "API contract finalized; frontend integration can begin"
python3 scripts/multiswarm.py complete CB-5090-001 inference-agent --summary "Baseline benchmark and runtime compatibility validated"
```

## Coordination rules

1. Every in-progress ticket has one explicit owner.
2. Tickets with unmet dependencies cannot be claimed unless `--force` is used.
3. Shared variables in `locked` state require owner consensus to change.
4. Any architecture-impacting change must be logged in `decisions.json`.
5. Handoffs must include rationale and next action note.

## Working cadence

1. Orchestrator runs `status` and `ready`.
2. Agents claim only ready tickets.
3. Agents update shared variables when assumptions or interfaces change.
4. Agents record decisions/handoffs to preserve context.
5. Orchestrator closes ticket only after acceptance criteria pass.
