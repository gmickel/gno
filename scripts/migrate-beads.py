#!/usr/bin/env python3
"""Migrate beads to Flow-Next format."""

import json
import subprocess
import sys
from pathlib import Path

FLOWCTL = "/Users/gordon/work/gmickel-claude-marketplace/plugins/flow-next/scripts/flowctl.py"

def flowctl(*args):
    """Run flowctl command and return JSON result."""
    cmd = ["python3", FLOWCTL] + list(args) + ["--json"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error: {result.stderr}", file=sys.stderr)
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        print(f"Invalid JSON: {result.stdout}", file=sys.stderr)
        return None

def get_beads():
    """Get all open beads."""
    result = subprocess.run(
        ["bd", "list", "--status=open", "--json"],
        capture_output=True, text=True
    )
    return json.loads(result.stdout)

def get_bead(bid):
    """Get single bead details."""
    result = subprocess.run(
        ["bd", "show", bid, "--json"],
        capture_output=True, text=True
    )
    data = json.loads(result.stdout)
    return data[0] if data else None

def write_spec(path, content):
    """Write spec content to file."""
    Path(path).write_text(content)

def main():
    beads = get_beads()

    # Categorize beads
    epics = {}
    subtasks = {}
    standalone = []

    for b in beads:
        bid = b['id']
        if '.' in bid:
            parent = bid.rsplit('.', 1)[0]
            if parent not in subtasks:
                subtasks[parent] = []
            subtasks[parent].append(b)
        elif b.get('issue_type') == 'epic':
            epics[bid] = b
        else:
            standalone.append(b)

    # Find implicit epics
    for parent in list(subtasks.keys()):
        if parent not in epics:
            parent_bead = get_bead(parent)
            if parent_bead:
                epics[parent] = parent_bead
                # Remove from standalone if there
                standalone = [s for s in standalone if s['id'] != parent]

    # Map bead IDs to flow IDs
    bead_to_flow = {}

    # Epic mapping (pre-defined order for predictability)
    epic_order = ['gno-ub9', 'gno-65x', 'gno-2yb', 'gno-b0n']
    # Add any other epics
    for eid in epics:
        if eid not in epic_order:
            epic_order.append(eid)

    print("=== Creating Epics ===")

    # fn-1 already created for Raycast, map it
    bead_to_flow['gno-ub9'] = 'fn-1'
    print(f"gno-ub9 -> fn-1 (already created)")

    # Create remaining epics
    next_epic = 2
    for eid in epic_order:
        if eid == 'gno-ub9':
            continue  # Already created

        epic = epics[eid]
        result = flowctl("epic", "create", "--title", epic['title'])
        if result and result.get('success'):
            flow_id = result['id']
            bead_to_flow[eid] = flow_id
            print(f"{eid} -> {flow_id}: {epic['title'][:50]}...")

            # Write epic spec with full description
            spec_path = f".flow/specs/{flow_id}.md"
            desc = epic.get('description', f"# {epic['title']}\n\nMigrated from beads {eid}")
            spec_content = f"""# {epic['title']}

**Migrated from:** {eid}
**Original type:** {epic.get('issue_type', 'epic')}
**Priority:** P{epic.get('priority', 2)}

---

{desc}
"""
            write_spec(spec_path, spec_content)

    # Create standalone items as single-task epics
    print("\n=== Creating Standalone Epics ===")
    for s in standalone:
        result = flowctl("epic", "create", "--title", s['title'])
        if result and result.get('success'):
            flow_id = result['id']
            bead_to_flow[s['id']] = flow_id
            print(f"{s['id']} -> {flow_id}: {s['title'][:50]}...")

            # Write epic spec
            spec_path = f".flow/specs/{flow_id}.md"
            desc = s.get('description', f"# {s['title']}")
            spec_content = f"""# {s['title']}

**Migrated from:** {s['id']}
**Original type:** {s.get('issue_type', 'task')}
**Priority:** P{s.get('priority', 2)}

---

{desc}
"""
            write_spec(spec_path, spec_content)

            # Create single task for standalone items
            task_result = flowctl("task", "create", "--epic", flow_id, "--title", f"Implement: {s['title'][:50]}")
            if task_result and task_result.get('success'):
                task_id = task_result['id']
                task_spec = f".flow/tasks/{task_id}.md"
                task_content = f"""# {s['title']}

## Description

{desc}

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
- [ ] Documentation updated
"""
                write_spec(task_spec, task_content)

    # Create tasks for epics with subtasks
    print("\n=== Creating Tasks Under Epics ===")
    for parent_id, tasks in subtasks.items():
        flow_epic = bead_to_flow.get(parent_id)
        if not flow_epic:
            print(f"Warning: No flow epic for {parent_id}")
            continue

        print(f"\n{parent_id} ({flow_epic}):")

        # Sort tasks by their numeric suffix
        tasks.sort(key=lambda t: int(t['id'].rsplit('.', 1)[1]) if '.' in t['id'] else 0)

        for task in tasks:
            # Map priority: beads 0-4 -> flow uses same
            priority = task.get('priority', 2) * 10  # Flow uses 10,20,30...

            result = flowctl("task", "create",
                           "--epic", flow_epic,
                           "--title", task['title'],
                           "--priority", str(priority))

            if result and result.get('success'):
                task_flow_id = result['id']
                bead_to_flow[task['id']] = task_flow_id
                print(f"  {task['id']} -> {task_flow_id}: {task['title'][:40]}...")

                # Write task spec
                task_spec = f".flow/tasks/{task_flow_id}.md"
                desc = task.get('description', f"# {task['title']}")
                task_content = f"""# {task['title']}

**Migrated from:** {task['id']}
**Priority:** P{task.get('priority', 2)}

## Description

{desc}

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
"""
                write_spec(task_spec, task_content)

    # Write mapping file for reference
    mapping_path = Path(".flow/bead-mapping.json")
    mapping_path.write_text(json.dumps(bead_to_flow, indent=2))
    print(f"\n=== Migration complete ===")
    print(f"Mapping saved to {mapping_path}")
    print(f"Epics: {len([k for k in bead_to_flow if not '.' in k])}")
    print(f"Tasks: {len([k for k in bead_to_flow if '.' in k])}")

if __name__ == "__main__":
    main()
