"""Derives the connection network fresh from the assertion ledger + issue resolutions
every time this runs -- a pure function, never hand-edited or incrementally updated.
This is the design doc's core discipline: if the aggregation rule changes later
(a different dispersion measure, a different hierarchy-index formula), rerunning this
against the same ledger is all that's needed, with no history to migrate.

Only assertions with status != "rejected" are included (unreviewed assertions count;
review is a quality signal, not a gate on whether evidence exists at all). An edge is
only created for an (from_issue, to_issue) pair that has at least one supporting
assertion -- so an edge simply not existing already means "no evidence," distinct
from an edge that exists with high dispersion, which means "contested" (see
mean_weight/dispersion below). Storing only a mean would render both alike as ~0.
"""
from __future__ import annotations

import statistics
from collections import defaultdict

import networkx as nx

MAX_CYCLE_LENGTH = 6


def _included(assertions: list[dict]) -> list[dict]:
    return [a for a in assertions if a.get("status") != "rejected"]


def _issue_id(resolutions: dict, assertion_id: str, side: str) -> str | None:
    resolution = resolutions.get(assertion_id)
    return resolution.get(f"{side}_issue_id") if resolution else None


def _role(out_degree: int, in_degree: int) -> str:
    if out_degree > 0 and in_degree == 0:
        return "driver"  # an external force -- affects things, nothing affects it
    if in_degree > 0 and out_degree == 0:
        return "outcome"  # something the group cares about, not itself influenceable
    return "ordinary"  # a candidate program -- both influences and is influenced


def _hierarchy_index(graph: nx.DiGraph) -> float | None:
    """MacDonald hierarchy index (as used by Özesmi & Özesmi 2004 for FCM structural
    analysis): normalized variance of out-degree across nodes, 0 (every node has the
    same out-degree -- a "collective" map) to 1 (fully hierarchical -- one node drives
    everything). NOT independently verified against the primary source here -- treat
    this as a first pass, same caveat the design doc's own reference implementation
    carried, and worth checking before reporting this number anywhere that matters.
    """
    n = graph.number_of_nodes()
    if n < 2:
        return None
    out_degrees = [d for _, d in graph.out_degree()]
    mean_out_degree = sum(out_degrees) / n
    variance_sum = sum((d - mean_out_degree) ** 2 for d in out_degrees)
    return (12 / (n**3 - n)) * variance_sum


def derive_network(ledger_rows: list[dict], resolutions: dict, issues: list | None = None) -> dict:
    issues_by_id = {issue.id: issue for issue in (issues or [])}
    assertions = _included(ledger_rows)

    edge_assertions: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for a in assertions:
        from_id = _issue_id(resolutions, a["id"], "from")
        to_id = _issue_id(resolutions, a["id"], "to")
        if from_id and to_id:
            edge_assertions[(from_id, to_id)].append(a)

    graph = nx.DiGraph()
    edges = []
    for (from_id, to_id), supporting in edge_assertions.items():
        weights = [a["weight"] for a in supporting]
        mean_weight = statistics.mean(weights)
        dispersion = statistics.pstdev(weights) if len(weights) > 1 else 0.0

        modality_counts: dict[str, int] = defaultdict(int)
        for a in supporting:
            modality_counts[a.get("modality", "asserted")] += 1

        transcript_speakers = {
            a["speaker"] for a in supporting if a.get("speaker")  # only ever set for transcript segments
        }
        distinct_meetings = {a["meeting_id"] for a in supporting}

        graph.add_edge(from_id, to_id, weight=mean_weight)
        edges.append({
            "from_issue_id": from_id,
            "to_issue_id": to_id,
            "mean_weight": mean_weight,
            "dispersion": dispersion,
            "assertion_count": len(supporting),
            "distinct_speaker_count": len(transcript_speakers),
            "distinct_meeting_count": len(distinct_meetings),
            "modality_counts": dict(modality_counts),
            "supporting_assertion_ids": [a["id"] for a in supporting],
        })

    nodes = []
    for issue_id in graph.nodes:
        out_degree = graph.out_degree(issue_id)
        in_degree = graph.in_degree(issue_id)
        issue = issues_by_id.get(issue_id)
        nodes.append({
            "issue_id": issue_id,
            "label": issue.canonical_label if issue else issue_id,
            "definition": issue.definition if issue else None,
            "out_degree": out_degree,
            "in_degree": in_degree,
            "centrality": out_degree + in_degree,
            "role": _role(out_degree, in_degree),
        })

    try:
        feedback_loops = [
            cycle for cycle in nx.simple_cycles(graph, length_bound=MAX_CYCLE_LENGTH)
        ]
    except nx.NetworkXNoCycle:
        feedback_loops = []

    input_type_breadth: dict[str, dict] = defaultdict(lambda: {
        "assertion_count": 0, "distinct_meeting_count": 0, "distinct_speaker_count": 0,
        "distinct_notetaker_count": 0,
    })
    meetings_by_type: dict[str, set] = defaultdict(set)
    speakers_by_type: dict[str, set] = defaultdict(set)
    notetakers_by_type: dict[str, set] = defaultdict(set)
    for a in assertions:
        input_type = a.get("input_type") or "unknown"
        input_type_breadth[input_type]["assertion_count"] += 1
        meetings_by_type[input_type].add(a.get("meeting_id"))
        if a.get("speaker"):
            speakers_by_type[input_type].add(a["speaker"])
        if a.get("notetaker"):
            notetakers_by_type[input_type].add(a["notetaker"])
    for input_type, breadth in input_type_breadth.items():
        breadth["distinct_meeting_count"] = len(meetings_by_type[input_type])
        breadth["distinct_speaker_count"] = len(speakers_by_type[input_type])
        breadth["distinct_notetaker_count"] = len(notetakers_by_type[input_type])

    return {
        "nodes": nodes,
        "edges": edges,
        "graph": {
            "density": nx.density(graph) if graph.number_of_nodes() > 1 else None,
            "hierarchy_index": _hierarchy_index(graph),
            "feedback_loops": feedback_loops,
        },
        # Never pooled across bases -- raw assertion counts aren't comparable between
        # a transcript (many small utterances) and notes (a handful of dense bullets)
        # of the same substance. A caller wanting a single "activity" number should
        # use assertion_count / meeting count *within* one basis, never summed across.
        "input_type_breadth": dict(input_type_breadth),
    }
