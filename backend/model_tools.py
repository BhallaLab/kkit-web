"""The "Tools" menu's four analyses, ported from the original GENESIS
kkit's xcomparemodel.g / tabulate_model.g / model_eqns.g / xfinddt.g --
re-read directly from ./kkit11 rather than guessed at. Kept separate from
moose_graph.py (which is purely about describing the live model for the
canvas) since these are standalone analyses/exports, not graph extraction.
"""
import math
from collections import Counter

import moose

from moose_graph import build_graph, name_path


# ---------------------------------------------------------------------
# 3. Model size
# ---------------------------------------------------------------------

def model_size(model_path):
    """Counts of each entity type -- reuses build_graph's own node list
    (rather than a separate wildcardFind scan) so this always agrees
    exactly with what the canvas is showing."""
    counts = Counter(n["type"] for n in build_graph(model_path)["nodes"])
    return dict(counts)


# ---------------------------------------------------------------------
# 4. DT / stiffness estimate (xfinddt.g)
# ---------------------------------------------------------------------

def _fractional_propensity(rate, counts):
    """kf * (product of a reaction's own reactant counts) / (smallest of
    those counts) -- the original tool's "fractional propensity": the
    rate at which the scarcest reactant would be depleted, relative to
    its own count. A reactant currently at zero molecules can't currently
    react, so (matching the original) it contributes 0, not a division
    blow-up."""
    if not counts:
        return 0.0
    smallest = min(counts)
    if smallest <= 0:
        return 0.0
    return rate * math.prod(counts) / smallest


def _fractional_propensities(model_path):
    """Yields (label, propensity) for every rate constant that can make a
    reaction/enzyme in this model "stiff" -- the largest one across the
    whole model sets the timestep. ConcChan is deliberately left out (per
    the user's own scoping call): it has no discrete per-molecule
    reactant-consumption step the way a Reac/Enz does, so the same
    "fractional propensity" measure doesn't have a natural analog for it."""
    for r in moose.wildcardFind(f"{model_path}/##[ISA=Reac]"):
        r = moose.element(r)
        sub_n = [moose.element(s).n for s in r.neighbors["sub"]]
        yield (f"{r.name} (kf)", _fractional_propensity(r.numKf, sub_n))
        prd_n = [moose.element(p).n for p in r.neighbors["prd"]]
        yield (f"{r.name} (kb)", _fractional_propensity(r.numKb, prd_n))

    for e in moose.wildcardFind(f"{model_path}/##[ISA=EnzBase]"):
        e = moose.element(e)
        if "MMenz" in e.className:
            # Rapid-equilibrium approximation has no separate complex step
            # to track -- kcat/Km is the linear-regime (S << Km) analog of
            # an explicit-complex enzyme's own k1, the per-substrate-
            # molecule rate constant.
            if e.Km > 0:
                yield (f"{e.name} (kcat/Km)", e.kcat * e.parent.n / e.Km)
            continue
        # k1's reactants are the substrate pool(s) *and* the enzyme's own
        # parent pool (the ENZYME role in the original tool's terms) --
        # both counts multiply into a bimolecular-style propensity.
        sub_n = [moose.element(s).n for s in e.neighbors["sub"]]
        sub_n.append(e.parent.n)
        yield (f"{e.name} (k1)", _fractional_propensity(e.k1, sub_n))
        # The complex's own decay (back to E+S via k2, or on to E+P via
        # k3) is a first-order process on a single pool -- no reactant
        # count to normalize by, the rate constants themselves are the
        # propensity.
        yield (f"{e.name} (k2+k3)", e.k2 + e.k3)


def find_dt(model_path, err):
    """dt = sqrt(err) / (stiffest fractional propensity in the model) --
    keeps one step's relative error near `err` (0.01 for 1%, 0.05 for
    5%). Also names which reaction/rate constant was the limiting one."""
    best_name, best_pf = None, 0.0
    for name, pf in _fractional_propensities(model_path):
        if pf > best_pf:
            best_name, best_pf = name, pf
    if best_pf <= 0:
        return {"dt": None, "stiffest": None, "propensity": 0.0}
    return {"dt": math.sqrt(err) / best_pf, "stiffest": best_name, "propensity": best_pf}


# ---------------------------------------------------------------------
# 1. Compare models (xcomparemodel.g)
# ---------------------------------------------------------------------

# (isa, comparable fields) -- EnzBase is handled specially below since its
# comparable fields depend on which mechanism each side actually uses.
# Order and labels mirror the original xcomparemodel.g's own separate
# "Comparing pool values" / "Comparing enzyme values" / "Comparing reac
# values" blocks, extended with this app's own ConcChan and Stimulus.
_COMPARE_FIELDS = [
    ("PoolBase", "Pools", ["concInit", "volume", "isBuffered"]),
    ("Reac", "Reactions", ["numKf", "numKb"]),
    ("EnzBase", "Enzymes", None),
    ("ConcChan", "Concentration channels", ["permeability"]),
    ("Function", "Stimuli", ["expr"]),
]


def _indexed_by_name_path(root, isa):
    result = {}
    for e in moose.wildcardFind(f"{root}/##[ISA={isa}]"):
        e = moose.element(e)
        result[name_path(e.path, root)] = e
    return result


def _enz_compare_fields(elem):
    return ["Km", "kcat"] if "MMenz" in elem.className else ["k1", "k2", "k3"]


def _values_differ(a, b):
    """A plain != flags a mountain of floating-point roundoff as real
    differences -- concInit/volume/rate-constant fields routinely differ
    at the 1e-15 relative level between two structurally-identical models
    (e.g. one saved/reloaded through SBML, one not) purely from float
    round-trip noise, not an actual parameter edit. Bools and strings
    still compare exactly -- only numeric fields get a tolerance, and
    bool is checked first since Python's bool is itself an int subclass."""
    if isinstance(a, bool) or isinstance(b, bool):
        return bool(a) != bool(b)
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return not math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-12)
    return a != b


def compare_groups(root_a, root_b):
    """Diffs kinetic parameters between two subtrees -- each treated as
    its own "root" for name_path purposes, so an element matches by its
    relative name/nesting rather than its absolute location, the same way
    this app already matches elements across an SBML save/reload.

    Reported in the same shape the original xcomparemodel.g used: a
    combined "elements present in one but not the other" pair of lists
    (spanning every entity kind, as the original's single wildcard query
    did), followed by separately-labeled value-comparison blocks per
    entity kind ("Comparing pool values", "Comparing enzyme values", ...,
    extended here with this app's own ConcChan/Stimulus, and Michaelis-
    Menten enzymes which the original never supported) -- the frontend
    renders each block under its own heading rather than one flat list,
    and supplies the two sides' display labels (group names, or "current
    model" / "file X") since this function doesn't know which mode
    (within-model vs against-file) the caller is in."""
    only_a, only_b = [], []
    blocks = []

    for isa, title, fields in _COMPARE_FIELDS:
        a = _indexed_by_name_path(root_a, isa)
        b = _indexed_by_name_path(root_b, isa)
        for key in a:
            if key not in b:
                only_a.append({"path": "/".join(key), "kind": isa})
        for key in b:
            if key not in a:
                only_b.append({"path": "/".join(key), "kind": isa})

        diffs = []
        for key, ea in a.items():
            eb = b.get(key)
            if eb is None:
                continue
            if fields is None:
                mech_a = "MMenz" in ea.className
                mech_b = "MMenz" in eb.className
                if mech_a != mech_b:
                    diffs.append({
                        "path": "/".join(key), "field": "mechanism",
                        "a": "michaelis-menten" if mech_a else "explicit-complex",
                        "b": "michaelis-menten" if mech_b else "explicit-complex",
                    })
                    continue
                cmp_fields = _enz_compare_fields(ea)
            else:
                cmp_fields = fields
            for f in cmp_fields:
                va, vb = getattr(ea, f), getattr(eb, f)
                if _values_differ(va, vb):
                    diffs.append({"path": "/".join(key), "field": f, "a": va, "b": vb})
        blocks.append({"kind": isa, "title": title, "diffs": diffs})

    total = len(only_a) + len(only_b) + sum(len(blk["diffs"]) for blk in blocks)
    return {"onlyInA": only_a, "onlyInB": only_b, "valueBlocks": blocks, "totalDiffCount": total}

    return {"onlyInA": only_a, "onlyInB": only_b, "diffs": diffs}


# ---------------------------------------------------------------------
# 2. Parameter + equation report (tabulate_model.g / model_eqns.g)
# ---------------------------------------------------------------------

def _equation_side(pools):
    """'2 A + B' style notation for a reaction/enzyme side -- counts
    repeated substrate/product pools (from a stoichiometry > 1 connection,
    which shows up as the same pool listed more than once) instead of
    printing "A + A"."""
    counts = Counter()
    order = []
    for p in pools:
        p = moose.element(p)
        if p.name not in counts:
            order.append(p.name)
        counts[p.name] += 1
    return " + ".join(f"{counts[n]} {n}" if counts[n] > 1 else n for n in order)


def build_report_sections(model_path):
    """A list of {title, headers, rows} sections -- a single intermediate
    form rendered to TSV/Markdown/LaTeX by the render_* functions below,
    so the traversal logic (this function) is written exactly once."""
    sections = []

    size = model_size(model_path)
    sections.append({
        "title": "Model size",
        "headers": ["Entity", "Count"],
        "rows": [[k, v] for k, v in sorted(size.items())],
    })

    compts = [moose.element(c) for c in moose.wildcardFind(f"{model_path}/##[ISA=CubeMesh]")]
    sections.append({
        "title": "Compartments",
        "headers": ["Name", "Volume (m^3)"],
        "rows": [[c.name, c.volume] for c in compts],
    })

    groups = [moose.element(g) for g in moose.wildcardFind(f"{model_path}/##[CLASS=Neutral]")]
    sections.append({
        "title": "Groups",
        "headers": ["Name", "Parent"],
        "rows": [[g.name, g.parent.name] for g in groups],
    })

    pools = [moose.element(p) for p in moose.wildcardFind(f"{model_path}/##[ISA=PoolBase]")]
    sections.append({
        "title": "Pools",
        "headers": ["Name", "concInit (mM)", "Volume (m^3)", "Buffered"],
        "rows": [[p.name, p.concInit, p.volume, bool(p.isBuffered)] for p in pools],
    })

    reacs = [moose.element(r) for r in moose.wildcardFind(f"{model_path}/##[ISA=Reac]")]
    sections.append({
        "title": "Reactions (parameters)",
        "headers": ["Name", "Kf", "Kb", "numKf", "numKb"],
        "rows": [[r.name, r.Kf, r.Kb, r.numKf, r.numKb] for r in reacs],
    })
    sections.append({
        "title": "Reactions (equations)",
        "headers": ["Equation", "kf", "kb"],
        "rows": [
            [f"{_equation_side(r.neighbors['sub'])} <=> {_equation_side(r.neighbors['prd'])}",
             r.numKf, r.numKb]
            for r in reacs
        ],
    })

    enzs = [moose.element(e) for e in moose.wildcardFind(f"{model_path}/##[ISA=EnzBase]")]
    enz_param_rows = []
    enz_eqn_rows = []
    for e in enzs:
        is_mm = "MMenz" in e.className
        enz_param_rows.append([
            e.name, "michaelis-menten" if is_mm else "explicit-complex",
            e.Km if is_mm else e.k1, e.kcat if is_mm else e.k2,
            "" if is_mm else e.k3,
        ])
        sub_side = _equation_side(list(e.neighbors["sub"]) + [e.parent])
        prd_side = _equation_side(e.neighbors["prd"])
        enz_eqn_rows.append([f"{sub_side} --{e.name}--> {prd_side}", e.kcat if is_mm else e.k3])
    sections.append({
        "title": "Enzymes (parameters)",
        "headers": ["Name", "Mechanism", "k1/Km", "k2/kcat", "k3"],
        "rows": enz_param_rows,
    })
    sections.append({
        "title": "Enzymes (equations)",
        "headers": ["Equation", "kcat/k3"],
        "rows": enz_eqn_rows,
    })

    chans = [moose.element(c) for c in moose.wildcardFind(f"{model_path}/##[ISA=ConcChan]")]
    sections.append({
        "title": "Concentration channels",
        "headers": ["Name", "Parent", "In", "Out", "Permeability"],
        "rows": [
            [c.name, c.parent.name,
             moose.element(list(c.neighbors["in"])[0]).name if c.neighbors["in"] else "",
             moose.element(list(c.neighbors["out"])[0]).name if c.neighbors["out"] else "",
             c.permeability]
            for c in chans
        ],
    })

    stims = [moose.element(f) for f in moose.wildcardFind(f"{model_path}/##[ISA=Function]")]
    from moose_graph import _stim_field
    stim_rows = []
    for f in stims:
        target_path, dest_field = _stim_field(f)
        target_name = moose.element(target_path).name if target_path else ""
        stim_rows.append([f.name, target_name, dest_field or "", f.expr])
    sections.append({
        "title": "Stimuli",
        "headers": ["Name", "Target", "Field", "Expression"],
        "rows": stim_rows,
    })

    return sections


def _render_tsv(sections):
    lines = []
    for sec in sections:
        lines.append(sec["title"])
        lines.append("\t".join(sec["headers"]))
        for row in sec["rows"]:
            lines.append("\t".join(str(v) for v in row))
        lines.append("")
    return "\n".join(lines)


def _render_markdown(sections):
    lines = ["# Model report", ""]
    for sec in sections:
        lines.append(f"## {sec['title']}")
        lines.append("")
        if sec["rows"]:
            lines.append("| " + " | ".join(sec["headers"]) + " |")
            lines.append("|" + "|".join(["---"] * len(sec["headers"])) + "|")
            for row in sec["rows"]:
                lines.append("| " + " | ".join(str(v) for v in row) + " |")
        else:
            lines.append("_(none)_")
        lines.append("")
    return "\n".join(lines)


def _latex_escape(value):
    text = str(value)
    for special, escaped in (
        ("\\", r"\textbackslash{}"), ("&", r"\&"), ("%", r"\%"), ("$", r"\$"),
        ("#", r"\#"), ("_", r"\_"), ("{", r"\{"), ("}", r"\}"),
        ("~", r"\textasciitilde{}"), ("^", r"\textasciicircum{}"),
    ):
        text = text.replace(special, escaped)
    return text


def _render_latex(sections):
    lines = [r"\documentclass{article}", r"\usepackage{booktabs}", r"\usepackage[margin=1in]{geometry}",
             r"\begin{document}", r"\title{Model report}", r"\maketitle"]
    for sec in sections:
        lines.append(r"\section*{" + _latex_escape(sec["title"]) + "}")
        if sec["rows"]:
            ncols = len(sec["headers"])
            lines.append(r"\begin{tabular}{" + "l" * ncols + "}")
            lines.append(r"\toprule")
            lines.append(" & ".join(_latex_escape(h) for h in sec["headers"]) + r" \\")
            lines.append(r"\midrule")
            for row in sec["rows"]:
                lines.append(" & ".join(_latex_escape(v) for v in row) + r" \\")
            lines.append(r"\bottomrule")
            lines.append(r"\end{tabular}")
        else:
            lines.append("(none)")
    lines.append(r"\end{document}")
    return "\n".join(lines)


_RENDERERS = {"tsv": _render_tsv, "markdown": _render_markdown, "latex": _render_latex}


def render_report(model_path, fmt):
    sections = build_report_sections(model_path)
    renderer = _RENDERERS.get(fmt)
    if renderer is None:
        raise ValueError(f"unknown report format: {fmt}")
    return renderer(sections)
