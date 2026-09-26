"""The "Tools" menu's four analyses, ported from the original GENESIS
kkit's xcomparemodel.g / tabulate_model.g / model_eqns.g / xfinddt.g --
re-read directly from ./kkit11 rather than guessed at. Kept separate from
moose_graph.py (which is purely about describing the live model for the
canvas) since these are standalone analyses/exports, not graph extraction.
"""
import math
import re
from collections import Counter

import moose

from moose_graph import build_graph, name_path, compartment_name, _conc_scale, _rate_unit_label, _reac_orders, _stim_field, _function_inputs


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

def _round_sig(value, digits=4):
    """Rounds a float to `digits` significant figures -- every unit
    conversion this report applies (mM->uM, m^3->fL, Kf/Kb's order-scaled
    conversion, ...) routinely produces recurring-decimal noise (e.g.
    1000.0/3 -> 333.33333333333337) that a plain round(value, N) can't
    fix uniformly across such different magnitudes. Bools/ints/strings
    pass through untouched -- bool is checked first since Python's bool
    is itself an int subclass -- and so does a non-finite/zero float,
    since log10 has no meaningful "magnitude" for either."""
    if isinstance(value, bool) or not isinstance(value, float):
        return value
    if value == 0 or not math.isfinite(value):
        return value
    magnitude = math.floor(math.log10(abs(value)))
    # Python's own round(value, ndigits) (ndigits may be negative, rounding
    # left of the decimal point) is correctly-rounded off the value's real
    # decimal representation -- unlike multiplying by 10**k, rounding, then
    # dividing back out, which can itself reintroduce the exact
    # recurring-decimal float noise this function exists to remove (10**k
    # for a large negative k, e.g. 1e-5, isn't exactly representable
    # either, verified directly: 123456789.123 rounded that way came out
    # 123499999.99999999, not a clean 123500000.0).
    return round(value, digits - 1 - magnitude)


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


def _build_functions_section(model_path):
    """Point 14: "Stimuli" renamed to "Functions", Name AND Field columns
    dropped (Name is this element's own synthetic "func" child name, never
    meaningful to a reader; Field only ever describes which pool field is
    being driven, and every Function this app creates always drives the
    same one -- see _stim_field -- so the column never varied row to row
    either) -- Target and Expression are what's actually informative, plus
    a new Inputs column (see _function_inputs) so a reader can see which
    molecules feed a summation without having to open the model. Only a
    plain, complete "x0+x1+...+x(N-1)" expression (every one of the
    function's own inputs, summed, nothing else) is worth collapsing to a
    capital Sigma -- a product, a partial sum, or a constant would be
    actively misrepresented by it, so those keep their literal expr text."""
    funcs = [moose.element(f) for f in moose.wildcardFind(f"{model_path}/##[ISA=Function]")]
    rows = []
    for f in funcs:
        target_path, _dest_field = _stim_field(f)
        target_name = moose.element(target_path).name if target_path else ""
        input_paths = _function_inputs(f)
        input_names = [moose.element(p).name for p in input_paths]
        expected_sum = "+".join(f"x{i}" for i in range(len(input_paths)))
        is_plain_sum = bool(input_paths) and f.expr.replace(" ", "") == expected_sum
        expr_display = "Σ" if is_plain_sum else f.expr
        rows.append([target_name, expr_display, ", ".join(input_names)])
    return {
        "title": "Functions",
        "headers": ["Target", "Expression", "Inputs"],
        "rows": rows,
        "latexFormatters": {1: _latex_sigma},
    }


def build_report_sections(model_path):
    """A list of {title, headers, rows} sections -- a single intermediate
    form rendered to TSV/Markdown/LaTeX by the render_* functions below,
    so the traversal logic (this function) is written exactly once.
    Concentration-like fields are converted to this app's own default
    display units (uM, s -- reusing moose_graph.py's own describe_pool/
    describe_reac/describe_enz conversions rather than re-deriving them)
    instead of MOOSE's native mM-based fields, so the report reads the
    same units the live canvas already shows.

    A section can carry an optional "latexFormatters": {col index:
    formatter} -- see _render_latex -- overriding plain _latex_escape for
    one column that needs real LaTeX notation instead (a "S + E --> P"
    equation's arrow, or a "uM^-1.s^-1" unit's exponent). The TSV/Markdown
    renderers below never look at this key, so those formats keep the
    plain-ASCII text unchanged (perfectly readable there; only LaTeX
    chokes on a bare "<=>"/"-->"/"^", see _render_latex)."""
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
        "headers": ["Name", "Volume (cubic microns, fL)"],
        # 1 m^3 = 1e18 cubic microns = 1e18 fL (1 fL = 1 cubic micron,
        # both being 1e-15 L) -- a single factor covers both unit names.
        "rows": [[c.name, _round_sig(c.volume * 1e18)] for c in compts],
    })

    # Only Neutrals actually organizing the kinetic model itself -- kkit's
    # own convention (this whole report is ported from GENESIS kkit's
    # tabulate_model.g) puts every real reaction-diagram group under the
    # compartment named "kinetics"; a bare wildcard from model_path also
    # picks up unrelated bookkeeping Neutrals living outside it.
    groups = [moose.element(g) for g in moose.wildcardFind(f"{model_path}/kinetics/##[CLASS=Neutral]")]
    sections.append({
        "title": "Groups",
        "headers": ["Name", "Parent"],
        "rows": [[g.name, g.parent.name] for g in groups],
    })

    pools = [moose.element(p) for p in moose.wildcardFind(f"{model_path}/##[ISA=PoolBase]")]
    # One table per containing compartment (see compartment_name), not one
    # flat Pools table with a Volume column that just repeats the same
    # parent compartment's volume on every one of its own pools' rows --
    # that column carries no per-pool information at all, only its
    # parent's, which the Compartments table above already states once.
    pools_by_compt = {c.name: [] for c in compts}
    for p in pools:
        compt = compartment_name(p.path, model_path)
        pools_by_compt.setdefault(compt or "(other)", []).append(p)
    for compt_name, compt_pools in pools_by_compt.items():
        if not compt_pools:
            continue
        sections.append({
            "title": f"Pools ({compt_name})",
            "headers": ["Name", "concInit (uM)", "Buffered"],
            "rows": [[p.name, _round_sig(p.concInit * 1000.0), bool(p.isBuffered)] for p in compt_pools],
        })

    reacs = [moose.element(r) for r in moose.wildcardFind(f"{model_path}/##[ISA=Reac]")]
    reac_rows = []
    for r in reacs:
        sub_order, prd_order = _reac_orders(r)
        # Same order-aware mM->uM scaling describe_reac already applies
        # for the live canvas (see _conc_scale's own comment: Kf/Kb carry
        # a *negative* concentration power, so this isn't a flat *1000).
        kf_display = r.Kf / _conc_scale(sub_order)
        kb_display = r.Kb / _conc_scale(prd_order)
        # One row per reaction -- the equation already names every
        # substrate/product, so a separate "Name" column is redundant
        # with it, and numKb/numKf (the number.time-units twin of the
        # concentration-based Kf/Kb just above) said nothing a reader
        # can't already get from Kf/Kb themselves.
        equation = f"{_equation_side(r.neighbors['sub'])} <=> {_equation_side(r.neighbors['prd'])}"
        reac_rows.append([
            equation,
            _round_sig(kf_display), _rate_unit_label(sub_order, False),
            _round_sig(kb_display), _rate_unit_label(prd_order, False),
        ])
    sections.append({
        "title": "Reactions",
        "headers": ["Equation", "Kf", "Kf unit", "Kb", "Kb unit"],
        "rows": reac_rows,
        "latexFormatters": {0: _latex_reac_arrow, 2: _latex_unit, 4: _latex_unit},
    })

    enzs = [moose.element(e) for e in moose.wildcardFind(f"{model_path}/##[ISA=EnzBase]")]
    explicit_rows = []
    mm_rows = []
    enz_eqn_rows = []
    for e in enzs:
        is_mm = "MMenz" in e.className
        # Km/kcat/ratio are native MOOSE fields on EITHER mechanism (for
        # explicit-complex, MOOSE derives them from k1/k2/k3 as read-only
        # readouts -- see moose_graph.py's describe_enz, which already
        # relies on this) -- reading them directly here avoids re-deriving
        # kcat==k3/ratio==k2/k3 by hand.
        km_display = _round_sig(e.Km * 1000.0)
        kcat_display = _round_sig(e.kcat)
        if is_mm:
            mm_rows.append([e.name, km_display, kcat_display])
        else:
            explicit_rows.append([e.name, km_display, kcat_display, _round_sig(e.ratio)])
        sub_side = _equation_side(list(e.neighbors["sub"]) + [e.parent])
        prd_side = _equation_side(e.neighbors["prd"])
        enz_eqn_rows.append([
            f"{sub_side} --{e.name}--> {prd_side}",
            "MM" if is_mm else "Mass Action",
        ])
    sections.append({
        "title": "Explicit-Complex Enzymes (parameters)",
        "headers": ["Name", "Km (uM)", "kcat (1/s)", "ratio k2/k3 (dimensionless)"],
        "rows": explicit_rows,
    })
    sections.append({
        "title": "Michaelis-Menten Enzymes (parameters)",
        "headers": ["Name", "Km (uM)", "kcat (1/s)"],
        "rows": mm_rows,
    })
    sections.append({
        "title": "Enzymes (equations)",
        "headers": ["Equation", "Type"],
        "rows": enz_eqn_rows,
        "latexFormatters": {0: _latex_enz_arrow},
    })

    chans = [moose.element(c) for c in moose.wildcardFind(f"{model_path}/##[ISA=ConcChan]")]
    sections.append({
        "title": "Concentration channels",
        "headers": ["Name", "Parent", "In", "Out", "Permeability"],
        "rows": [
            [c.name, c.parent.name,
             moose.element(list(c.neighbors["in"])[0]).name if c.neighbors["in"] else "",
             moose.element(list(c.neighbors["out"])[0]).name if c.neighbors["out"] else "",
             _round_sig(c.permeability)]
            for c in chans
        ],
    })

    sections.append(_build_functions_section(model_path))

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


# "<=>" and "--EnzName-->" are plain ASCII placeholders (see
# build_report_sections/_equation_side) -- perfectly fine as-is for
# TSV/Markdown, but LaTeX has no such ligature and _latex_escape's plain
# per-character escaping would just print the literal dashes/angle
# brackets rather than an actual arrow. These two formatters replace the
# whole marker with a real math-mode arrow (\rightleftharpoons for a
# reversible reaction, \xrightarrow{} labeled with the enzyme name for a
# catalyzed one), while still routing each side's own text through
# _latex_escape first -- a molecule name can itself contain an underscore
# (e.g. "MAPK_P") that needs escaping same as any other cell.
def _latex_reac_arrow(text):
    if " <=> " not in text:
        return _latex_escape(text)
    sub, prd = text.split(" <=> ", 1)
    return f"{_latex_escape(sub)} $\\rightleftharpoons$ {_latex_escape(prd)}"


_ENZ_EQUATION_RE = re.compile(r"^(.*) --(.+)--> (.*)$")


def _latex_enz_arrow(text):
    m = _ENZ_EQUATION_RE.match(text)
    if not m:
        return _latex_escape(text)
    sub, enz_name, prd = m.groups()
    return f"{_latex_escape(sub)} $\\xrightarrow{{\\text{{{_latex_escape(enz_name)}}}}}$ {_latex_escape(prd)}"


_UNIT_EXPONENT_RE = re.compile(r"\\textasciicircum\{\}(-?\d+)")


def _latex_unit(text):
    """A rate-constant unit label (see moose_graph.py's _rate_unit_label,
    e.g. "µM^-1.s^-1") uses a bare "^" for its exponent -- _latex_escape's
    own generic per-character escaping turns that into a literal
    circumflex glyph (\\textasciicircum{}) followed by plain "-1" text,
    not a real superscript. Escapes everything else the normal way first,
    then replaces just the exponent with a proper LaTeX superscript. The
    label's own leading micro sign (a raw Unicode µ, MICRO SIGN --
    _MICROMOLAR's literal value) gets the same treatment for the same
    reason: plain pdflatex has no font glyph for it without extra package
    support, but its math-mode equivalent ($\\mu$) always renders."""
    escaped = _UNIT_EXPONENT_RE.sub(r"$^{\1}$", _latex_escape(text))
    return escaped.replace("µ", r"$\mu$")


def _latex_sigma(text):
    """The Functions table's own "Σ" summation marker (see
    _build_functions_section) is the identical problem _latex_unit solves
    for a bare micro sign -- a raw Unicode capital sigma has no plain-
    pdflatex glyph either, but $\\Sigma$ always renders. Anything else in
    this column (a function that isn't a plain summation keeps its
    literal expr text) is just escaped normally."""
    return r"$\Sigma$" if text == "Σ" else _latex_escape(text)


def _render_latex(sections):
    lines = [r"\documentclass{article}", r"\usepackage{amsmath}", r"\usepackage{booktabs}",
             r"\usepackage[margin=1in]{geometry}",
             r"\begin{document}", r"\title{Model report}", r"\maketitle"]
    for sec in sections:
        lines.append(r"\section*{" + _latex_escape(sec["title"]) + "}")
        if sec["rows"]:
            ncols = len(sec["headers"])
            lines.append(r"\begin{tabular}{" + "l" * ncols + "}")
            lines.append(r"\toprule")
            lines.append(" & ".join(_latex_escape(h) for h in sec["headers"]) + r" \\")
            lines.append(r"\midrule")
            formatters = sec.get("latexFormatters", {})
            for row in sec["rows"]:
                cells = [formatters.get(i, _latex_escape)(v) for i, v in enumerate(row)]
                lines.append(" & ".join(cells) + r" \\")
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
