#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
SWARM_DIR = REPO_ROOT / 'multiswarm'
AGENTS_FILE = SWARM_DIR / 'agents.json'
TICKETS_FILE = SWARM_DIR / 'tickets.json'
VARIABLES_FILE = SWARM_DIR / 'variables.json'
DECISIONS_FILE = SWARM_DIR / 'decisions.json'


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return default
    with path.open('r', encoding='utf-8') as handle:
        return json.load(handle)


def save_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8') as handle:
        json.dump(data, handle, indent=2)
        handle.write('\n')


def load_state() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    agents = load_json(AGENTS_FILE, {'agents': []})
    tickets = load_json(TICKETS_FILE, {'tickets': []})
    variables = load_json(VARIABLES_FILE, {'variables': []})
    decisions = load_json(DECISIONS_FILE, {'decisions': []})
    return agents, tickets, variables, decisions


def save_tickets(tickets_doc: dict[str, Any]) -> None:
    tickets_doc['updatedAt'] = utc_now()
    save_json(TICKETS_FILE, tickets_doc)


def save_variables(variables_doc: dict[str, Any]) -> None:
    variables_doc['updatedAt'] = utc_now()
    save_json(VARIABLES_FILE, variables_doc)


def save_decisions(decisions_doc: dict[str, Any]) -> None:
    decisions_doc['updatedAt'] = utc_now()
    save_json(DECISIONS_FILE, decisions_doc)


def by_id(items: list[dict[str, Any]], key: str = 'id') -> dict[str, dict[str, Any]]:
    return {item[key]: item for item in items if key in item}


def ensure_agent_exists(agents_doc: dict[str, Any], agent_id: str) -> None:
    agent_map = by_id(agents_doc.get('agents', []), key='id')
    if agent_id not in agent_map:
        raise ValueError(f'Unknown agent: {agent_id}')


def ensure_ticket_exists(tickets_doc: dict[str, Any], ticket_id: str) -> dict[str, Any]:
    ticket_map = by_id(tickets_doc.get('tickets', []))
    if ticket_id not in ticket_map:
        raise ValueError(f'Unknown ticket: {ticket_id}')
    return ticket_map[ticket_id]


def dependencies_met(ticket: dict[str, Any], ticket_map: dict[str, dict[str, Any]]) -> bool:
    for dep in ticket.get('dependsOn', []):
        dep_ticket = ticket_map.get(dep)
        if dep_ticket is None:
            return False
        if dep_ticket.get('status') != 'done':
            return False
    return True


def ready_tickets(tickets_doc: dict[str, Any]) -> list[dict[str, Any]]:
    tickets = tickets_doc.get('tickets', [])
    ticket_map = by_id(tickets)
    return [
        ticket for ticket in tickets
        if ticket.get('status') == 'todo' and dependencies_met(ticket, ticket_map)
    ]


def append_history(ticket: dict[str, Any], event: str, agent: str, note: str) -> None:
    ticket.setdefault('history', []).append({
        'at': utc_now(),
        'event': event,
        'agent': agent,
        'note': note,
    })


def add_decision(
    decisions_doc: dict[str, Any],
    ticket_id: str,
    agent_id: str,
    summary: str,
    impact: str,
) -> None:
    decisions_doc.setdefault('decisions', []).append({
        'at': utc_now(),
        'ticket': ticket_id,
        'agent': agent_id,
        'summary': summary,
        'impact': impact,
    })


def command_status(args: argparse.Namespace) -> int:
    _, tickets_doc, variables_doc, _ = load_state()
    tickets = tickets_doc.get('tickets', [])
    status_counts: dict[str, int] = {}
    for ticket in tickets:
        status = ticket.get('status', 'unknown')
        status_counts[status] = status_counts.get(status, 0) + 1

    print('MultiSwarm Status')
    print('-----------------')
    for status in sorted(status_counts):
        print(f'{status:12} {status_counts[status]}')

    print('\nReady tickets')
    print('-------------')
    ready = ready_tickets(tickets_doc)
    if not ready:
        print('none')
    else:
        for ticket in ready:
            print(f"{ticket['id']} | {ticket.get('priority', '?')} | suggested={ticket.get('suggestedOwner', 'unassigned')} | {ticket.get('title', '')}")

    print('\nLocked variables')
    print('----------------')
    locked = [v for v in variables_doc.get('variables', []) if v.get('status') == 'locked']
    if not locked:
        print('none')
    else:
        for variable in locked:
            print(f"{variable.get('name')} = {variable.get('value')} (owner={variable.get('owner')})")

    return 0


def command_ready(args: argparse.Namespace) -> int:
    _, tickets_doc, _, _ = load_state()
    ready = ready_tickets(tickets_doc)
    if args.agent:
        ready = [
            ticket for ticket in ready
            if ticket.get('suggestedOwner') == args.agent or ticket.get('owner') == args.agent
        ]
    if not ready:
        print('No ready tickets found.')
        return 0

    for ticket in ready:
        print(f"{ticket['id']} | {ticket.get('priority', '?')} | suggested={ticket.get('suggestedOwner', 'unassigned')} | {ticket.get('title', '')}")
    return 0


def command_assign_suggested(args: argparse.Namespace) -> int:
    agents_doc, tickets_doc, _, _ = load_state()
    agent_map = by_id(agents_doc.get('agents', []), key='id')
    changed = 0

    for ticket in tickets_doc.get('tickets', []):
        suggested = ticket.get('suggestedOwner')
        if not suggested or suggested not in agent_map:
            continue
        if ticket.get('status') == 'done':
            continue
        if ticket.get('owner') == suggested:
            continue
        if ticket.get('owner') and not args.force:
            continue

        ticket['owner'] = suggested
        append_history(
            ticket,
            'assign-suggested',
            'swarm-orchestrator',
            f'assigned owner={suggested}',
        )
        changed += 1

    if changed > 0:
        save_tickets(tickets_doc)

    print(f'Assigned suggested owners on {changed} ticket(s).')
    return 0


def command_claim(args: argparse.Namespace) -> int:
    agents_doc, tickets_doc, _, _ = load_state()
    ensure_agent_exists(agents_doc, args.agent)
    ticket = ensure_ticket_exists(tickets_doc, args.ticket)
    ticket_map = by_id(tickets_doc.get('tickets', []))

    if ticket.get('status') == 'done':
        raise ValueError(f"Ticket {args.ticket} is already done.")

    if not dependencies_met(ticket, ticket_map) and not args.force:
        raise ValueError(
            f"Ticket {args.ticket} has unmet dependencies. Use --force to override."
        )

    ticket['owner'] = args.agent
    ticket['status'] = 'in-progress'
    append_history(ticket, 'claim', args.agent, args.note or 'claimed for implementation')
    save_tickets(tickets_doc)
    print(f"Claimed {args.ticket} by {args.agent}.")
    return 0


def command_complete(args: argparse.Namespace) -> int:
    agents_doc, tickets_doc, decisions_doc, _ = load_state()
    ensure_agent_exists(agents_doc, args.agent)
    ticket = ensure_ticket_exists(tickets_doc, args.ticket)

    if ticket.get('owner') and ticket.get('owner') != args.agent and not args.force:
        raise ValueError(
            f"Ticket {args.ticket} is owned by {ticket.get('owner')}. Use --force to override."
        )

    ticket['status'] = 'done'
    ticket['owner'] = args.agent
    ticket['completedAt'] = utc_now()
    ticket['completionSummary'] = args.summary
    append_history(ticket, 'complete', args.agent, args.summary)

    add_decision(
        decisions_doc,
        ticket_id=args.ticket,
        agent_id=args.agent,
        summary=f"Completed: {ticket.get('title', args.ticket)}",
        impact=args.summary,
    )

    save_tickets(tickets_doc)
    save_decisions(decisions_doc)
    print(f"Completed {args.ticket} by {args.agent}.")
    return 0


def command_handoff(args: argparse.Namespace) -> int:
    agents_doc, tickets_doc, decisions_doc, _ = load_state()
    ensure_agent_exists(agents_doc, args.from_agent)
    ensure_agent_exists(agents_doc, args.to_agent)
    ticket = ensure_ticket_exists(tickets_doc, args.ticket)

    if ticket.get('owner') != args.from_agent and not args.force:
        raise ValueError(
            f"Ticket {args.ticket} is owned by {ticket.get('owner')}, not {args.from_agent}. Use --force to override."
        )

    previous_status = ticket.get('status', 'todo')
    if previous_status == 'done':
        raise ValueError(f"Ticket {args.ticket} is already done; handoff is not allowed.")

    ticket['owner'] = args.to_agent
    ticket['status'] = 'in-progress'
    append_history(
        ticket,
        'handoff',
        args.from_agent,
        f"to={args.to_agent}; note={args.note}",
    )

    add_decision(
        decisions_doc,
        ticket_id=args.ticket,
        agent_id=args.from_agent,
        summary=f"Handoff to {args.to_agent}",
        impact=args.note,
    )

    save_tickets(tickets_doc)
    save_decisions(decisions_doc)
    print(f"Handed off {args.ticket} from {args.from_agent} to {args.to_agent}.")
    return 0


def command_block(args: argparse.Namespace) -> int:
    agents_doc, tickets_doc, decisions_doc, _ = load_state()
    ensure_agent_exists(agents_doc, args.agent)
    ticket = ensure_ticket_exists(tickets_doc, args.ticket)

    ticket['owner'] = args.agent
    ticket['status'] = 'blocked'
    ticket['blockedReason'] = args.reason
    append_history(ticket, 'block', args.agent, args.reason)

    add_decision(
        decisions_doc,
        ticket_id=args.ticket,
        agent_id=args.agent,
        summary='Ticket blocked',
        impact=args.reason,
    )

    save_tickets(tickets_doc)
    save_decisions(decisions_doc)
    print(f"Blocked {args.ticket} by {args.agent}.")
    return 0


def command_set_var(args: argparse.Namespace) -> int:
    agents_doc, tickets_doc, variables_doc, decisions_doc = load_state()
    ensure_agent_exists(agents_doc, args.agent)

    if args.ticket:
        ensure_ticket_exists(tickets_doc, args.ticket)

    variables = variables_doc.setdefault('variables', [])
    variable_map = {v.get('name'): v for v in variables}
    variable = variable_map.get(args.name)

    if variable is None:
        variable = {
            'name': args.name,
            'value': args.value,
            'status': args.status,
            'owner': args.agent,
            'ticket': args.ticket,
            'history': [],
        }
        variables.append(variable)
    else:
        locked_by_other = (
            variable.get('status') == 'locked'
            and variable.get('owner') != args.agent
        )
        if locked_by_other and not args.force:
            raise ValueError(
                f"Variable {args.name} is locked by {variable.get('owner')}. Use --force to override."
            )

        variable['value'] = args.value
        variable['status'] = args.status
        variable['owner'] = args.agent
        if args.ticket:
            variable['ticket'] = args.ticket

    variable.setdefault('history', []).append({
        'at': utc_now(),
        'agent': args.agent,
        'value': args.value,
        'status': args.status,
        'ticket': args.ticket,
        'rationale': args.rationale,
    })

    add_decision(
        decisions_doc,
        ticket_id=args.ticket or 'N/A',
        agent_id=args.agent,
        summary=f"Variable update: {args.name}",
        impact=f"{args.value} ({args.status}) — {args.rationale}",
    )

    save_variables(variables_doc)
    save_decisions(decisions_doc)
    print(f"Updated variable {args.name}.")
    return 0


def command_decision(args: argparse.Namespace) -> int:
    agents_doc, tickets_doc, _, decisions_doc = load_state()
    ensure_agent_exists(agents_doc, args.agent)
    ensure_ticket_exists(tickets_doc, args.ticket)

    add_decision(
        decisions_doc,
        ticket_id=args.ticket,
        agent_id=args.agent,
        summary=args.summary,
        impact=args.impact,
    )
    save_decisions(decisions_doc)
    print(f"Logged decision for {args.ticket}.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='MultiSwarm coordination CLI',
    )
    sub = parser.add_subparsers(dest='command', required=True)

    sub.add_parser('status', help='Show ticket/variable status overview')

    ready = sub.add_parser('ready', help='List tickets whose dependencies are complete')
    ready.add_argument('--agent', help='Filter by suggested or current owner')

    assign = sub.add_parser(
        'assign-suggested',
        help='Assign ticket owners using suggestedOwner field',
    )
    assign.add_argument(
        '--force',
        action='store_true',
        help='Overwrite existing owner assignments on non-done tickets',
    )

    claim = sub.add_parser('claim', help='Claim a ticket and set it in-progress')
    claim.add_argument('ticket')
    claim.add_argument('agent')
    claim.add_argument('--note', default='')
    claim.add_argument('--force', action='store_true')

    complete = sub.add_parser('complete', help='Mark a ticket as done')
    complete.add_argument('ticket')
    complete.add_argument('agent')
    complete.add_argument('--summary', required=True)
    complete.add_argument('--force', action='store_true')

    handoff = sub.add_parser('handoff', help='Transfer ownership to another agent')
    handoff.add_argument('ticket')
    handoff.add_argument('from_agent')
    handoff.add_argument('to_agent')
    handoff.add_argument('--note', required=True)
    handoff.add_argument('--force', action='store_true')

    block = sub.add_parser('block', help='Mark a ticket as blocked')
    block.add_argument('ticket')
    block.add_argument('agent')
    block.add_argument('--reason', required=True)

    set_var = sub.add_parser('set-var', help='Update shared variable value/owner/status')
    set_var.add_argument('name')
    set_var.add_argument('value')
    set_var.add_argument('agent')
    set_var.add_argument('--status', choices=['proposed', 'locked'], default='proposed')
    set_var.add_argument('--ticket')
    set_var.add_argument('--rationale', required=True)
    set_var.add_argument('--force', action='store_true')

    decision = sub.add_parser('decision', help='Log a cross-agent decision')
    decision.add_argument('ticket')
    decision.add_argument('agent')
    decision.add_argument('summary')
    decision.add_argument('--impact', default='')

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        if args.command == 'status':
            return command_status(args)
        if args.command == 'ready':
            return command_ready(args)
        if args.command == 'assign-suggested':
            return command_assign_suggested(args)
        if args.command == 'claim':
            return command_claim(args)
        if args.command == 'complete':
            return command_complete(args)
        if args.command == 'handoff':
            return command_handoff(args)
        if args.command == 'block':
            return command_block(args)
        if args.command == 'set-var':
            return command_set_var(args)
        if args.command == 'decision':
            return command_decision(args)
    except ValueError as error:
        print(f'error: {error}', file=sys.stderr)
        return 2

    parser.print_help()
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
