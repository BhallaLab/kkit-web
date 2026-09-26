"""Extract a node/edge graph description from a live MOOSE chemical model.

This is NOT a persisted file format -- it's just the API response shape used
to draw the React Flow canvas. Persistence goes through moose.loadModel
(legacy .g import) and moose.writeSBML/readSBML (native save/load).
"""
import colorsys
import math
import re

import moose

_HSL_RE = re.compile(r"^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$", re.IGNORECASE)


def normalize_color(value):
    """The frontend's color picker offers CSS hsl(...) swatches (see
    colorUtils.js's RAINBOW_16) -- moose.writeSBML's own color parser only
    understands a #hex string, a plain color name, or a bare comma-
    separated r,g,b tuple (verified directly: an hsl(...) string crashes
    it -- colorCheck strips only bracket characters before splitting on
    commas and calling int() on each piece, so "hsl(0, 70%, 50%)" becomes
    "hsl0, 70%, 50%" -> int("hsl0") -> ValueError). Converting to #hex here,
    at the single point every color is actually stored (create_info, and
    server.py's update-field path), keeps every other color-consuming path
    (SBML save foremost) working with a format moose can always handle."""
    if not isinstance(value, str):
        return value
    m = _HSL_RE.match(value.strip())
    if not m:
        return value
    h, s, l = (float(x) for x in m.groups())
    r, g, b = colorsys.hls_to_rgb(h / 360.0, l / 100.0, s / 100.0)
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))

# CubeMesh has no native "diameter" -- kkit's classic convention treats a
# compartment's size as a sphere-equivalent diameter for display/editing
# purposes even though it's cube-shaped, so this is a derived, invertible
# convenience rather than a real geometric property of the mesh.
def volume_to_diameter(volume):
    return (6.0 * volume / math.pi) ** (1.0 / 3.0)


def diameter_to_volume(diameter):
    return (math.pi / 6.0) * diameter ** 3


def _info(path):
    if not moose.exists(path + "/info"):
        return {"x": 0.0, "y": 0.0, "color": "white", "textColor": "black", "notes": "", "width": 0.0, "height": 0.0}
    info = moose.element(path + "/info")
    return {
        "x": info.x,
        "y": info.y,
        "color": info.color,
        "textColor": info.textColor,
        "notes": info.notes,
        # Annotator's own native width/height fields ("typically display
        # width/height") -- only meaningful for group/compartment nodes, but
        # harmless (just unused) on everything else.
        "width": info.width,
        "height": info.height,
    }


def create_info(path, x, y, color="white", notes="", width=0.0, height=0.0):
    info = moose.Annotator(path + "/info")
    info.x = x
    info.y = y
    info.color = normalize_color(color)
    info.textColor = "black"
    info.notes = notes
    info.width = width
    info.height = height
    return info


def _node(elem, node_type, extra=None):
    node = {
        "id": elem.path,
        "type": node_type,
        "name": elem.name,
        **_info(elem.path),
    }
    if extra:
        node.update(extra)
    return node


_CONTAINER_CLASSES = ("Neutral", "CubeMesh")


def container_parent_id(path, model_path):
    """Walks up from `path` to the nearest ancestor that's a recognized
    container -- a plain Neutral "group", or a CubeMesh "compartment" --
    stopping at the model root (never treated as a container itself, even
    though it's technically also a bare Neutral) so a top-level compartment
    correctly gets no parent at all (compartments never nest).

    This is a node's own immediate parent in the ordinary case (a plain
    pool/reac, or a group sitting directly in a compartment or another
    group). It takes more than one hop for an enzyme (parented under its
    substrate pool, not a container) and an enzyme's hidden complex pool
    (parented under the enzyme itself) -- both walk past those non-container
    ancestors to whatever group/compartment they conceptually belong to.
    """
    elem = moose.element(path).parent
    while elem.path not in (model_path, "/"):
        if elem.className in _CONTAINER_CLASSES:
            return elem.path
        elem = elem.parent
    return None


def detect_existing_plots(model_path):
    """kkit's own .g format already tracks which pools are plotted, in two
    fixed top-level folders alongside the compartment(s) -- "graphs" (plot
    window 1) and "moregraphs" (window 2), each holding Table2 objects that
    request a pool's concentration. Verified directly against several kkit11
    example files (feedback.g, inhib_fb.g, pkc.g): a Table's own
    requestOut neighbor is exactly the plotted pool. Read back here so a
    freshly-loaded model shows the same molecules already marked as plotted
    in the original file, instead of starting with nothing plotted."""
    result = {}
    for window, folder in ((1, "graphs"), (2, "moregraphs")):
        base = f"{model_path}/{folder}"
        if not moose.exists(base):
            continue
        for tab in moose.wildcardFind(base + "/##[ISA=Table2]"):
            tab = moose.element(tab)
            targets = tab.neighbors["requestOut"]
            if len(targets) == 1:
                result[moose.element(targets[0]).path] = window
    return result


def is_enz_complex(path):
    """The hidden "cplx" pool an explicit-complex enzyme owns (created
    alongside it in create_enz, or already present in a loaded .g/SBML file)
    is structurally nested directly under its parent Enz element -- that
    nesting, not the name, is the reliable signal (verified directly: an
    Enz's own cplx pool's .parent.className is "Enz"; a plain pool's parent
    is a Neutral/compartment)."""
    p = moose.element(path)
    parent = p.parent
    return parent is not None and "Enz" in parent.className


def compartment_name(path, model_path):
    """Name of the nearest enclosing CubeMesh, walking up from `path`."""
    elem = moose.element(path).parent
    while elem.path not in (model_path, "/"):
        if elem.className == "CubeMesh":
            return elem.name
        elem = elem.parent
    return None


def name_path(path, model_path):
    """A stable, session-independent identifier for `path`: a tuple of
    names from the enclosing compartment down to this object. Used (instead
    of MOOSE's own idValue, verified to be a global, ever-incrementing
    counter that differs across sessions/reloads -- even reloading the same
    file twice gives different idValues) to match a live object to its SBML
    representation, or vice versa.

    Deliberately mirrors exactly what's reconstructable from the *SBML*
    side (see server.py's _SbmlNamePaths), not a naive "walk every
    ancestor": an enzyme has no container of its own in kkit (it's
    structurally parented under its substrate pool), so its path is that
    pool's path plus its own name -- the only placement SBML can express
    for it too, via the moose:enzyme annotation. An enzyme's complex pool
    is neither an SBML group member nor does it carry any back-reference to
    its enzyme, so it collapses to just (compartment, own name), same as
    any other non-grouped pool -- matching it via its full live nesting
    would have no SBML-side counterpart to agree with.
    """
    elem = moose.element(path)
    if is_enz_complex(path):
        return (compartment_name(path, model_path), elem.name)
    if elem.className in ("Enz", "MMenz", "ConcChan"):
        # A ConcChan is structurally nested under its "parent" pool exactly
        # like an enzyme is under its substrate -- and on the SBML side it
        # round-trips the same way an MM enzyme does (as a <reaction> with a
        # single modifier species, no dedicated moose:enzyme-style tag of
        # its own -- verified directly), so it needs the same treatment
        # here as Enz/MMenz for the two sides to agree.
        return name_path(elem.parent.path, model_path) + (elem.name,)

    names = [elem.name]
    cur = elem.parent
    while cur.path != model_path:
        names.append(cur.name)
        cur = cur.parent
    names.reverse()
    return tuple(names)


_MICROMOLAR = "µM"


def _reac_orders(elem):
    """Number of substrate/product connections -- the reaction's forward/
    backward "order" in kkit's own sense (xreac.g's find_reac_order),
    used both for the Kd/Keq calculation and for picking the right
    concentration-power unit label on Kf/Kb. Counts duplicates (a
    stoichiometry > 1 connection is multiple separate messages, see
    build_graph's own edge-counting), matching find_reac_order's own
    plain message count."""
    return len(elem.neighbors["sub"]), len(elem.neighbors["prd"])


def _conc_scale(order):
    """The mM<->uM conversion factor for a rate constant of this reaction
    order -- one factor of 1000 per concentration power beyond the first
    (order 0 or 1 has no concentration dependence at all, so no scaling
    applies). Unlike a plain concentration (Pool.conc, Enz.Km: uM value =
    mM value * 1000, a positive power of concentration), Reac.Kf/Kb carry
    a *negative* power of concentration -- conc^-(order-1) (verified
    directly: MOOSE's own Reac.Kf is the order-scaled, mM-based field
    that numKf is derived *from*, not the other way around) -- so
    converting mM -> uM divides by this factor, and uM -> mM (see
    update_reac) multiplies by it; both are the inverse of what a plain
    concentration's conversion does."""
    return 1000.0 ** max(order - 1, 0)


def _rate_unit_label(order, per_molecule):
    """Matches xreac.g's dump_units/dump_num_units exactly: order 0 or 1
    is a plain rate (s^-1, no concentration term); order >= 2 needs
    (order-1) inverse powers of concentration alongside it -- in # units
    for numKf/numKb, in uM for the concentration-based Kf/Kb."""
    if order < 2:
        return "s^-1"
    conc = "#" if per_molecule else _MICROMOLAR
    return f"{conc}^-{order - 1}.s^-1"


def describe_pool(path, plot_window=None):
    p = moose.element(path)
    return _node(p, "pool", {
        "n": p.n,
        "nInit": p.nInit,
        # MOOSE's own pool concentration fields are natively in mM
        # (verified directly) -- converted here to this app's default
        # display unit, uM (matching kkit's own DEFAULT_CONC_UNITS), so
        # the raw mM value is never shown to or edited by the user.
        "conc": p.conc * 1000.0,
        "concInit": p.concInit * 1000.0,
        "concUnit": _MICROMOLAR,
        "concInitUnit": _MICROMOLAR,
        "diffConst": p.diffConst,
        "motorConst": p.motorConst,
        "volume": p.volume,
        "isBuffered": p.isBuffered,
        "isEnzComplex": is_enz_complex(path),
        "plotWindow": plot_window,
    })


def _kd_value(sub_order, prd_order, kf_display, kb_display):
    """kd (or Keq, when sub_order == prd_order) for a reaction whose
    already-uM-scaled forward/backward rates are kf_display/kb_display --
    ported from xreac.g's do_update_reac_scaling. Same order both ways is
    a dimensionless equilibrium constant (Keq = kf/kb, units cancel);
    different orders is a real Kd with concentration units, taking the
    (sub_order - prd_order)-th root of kb/kf so the units come out to a
    single concentration power regardless of the reaction's order. None
    when there isn't a meaningful ratio yet (a rate of exactly zero, or --
    physically impossible for non-negative rates, but guarded anyway -- a
    negative one)."""
    if sub_order == prd_order:
        return kf_display / kb_display if kb_display != 0 else None
    if kf_display == 0:
        return None
    ratio = kb_display / kf_display
    if ratio < 0:
        return None
    exponent = 1.0 / (sub_order - prd_order)
    # An irreversible reaction (kb == 0, extremely common -- degradation,
    # dephosphorylation, ...) with more products than substrates in its
    # order gives ratio == 0 and a *negative* exponent here -- 0 raised to
    # a negative power is undefined (Python raises ZeroDivisionError, not
    # just returns inf), and physically Kd really would be infinite (the
    # reaction never runs backward even a little), so there's no finite
    # value to report.
    if ratio == 0 and exponent < 0:
        return None
    return ratio ** exponent


def describe_reac(path):
    r = moose.element(path)
    sub_order, prd_order = _reac_orders(r)
    # Kf/Kb (concentration.time units, mM-based) and numKf/numKb (number.
    # time units) are both native MOOSE fields, kept in sync internally --
    # Kf/Kb are converted to uM display units here per this app's default
    # concentration unit (see _conc_scale); numKf/numKb are left as-is
    # (never concentration-based, so uM doesn't apply to them).
    kf_display = r.Kf / _conc_scale(sub_order)
    kb_display = r.Kb / _conc_scale(prd_order)

    kd = _kd_value(sub_order, prd_order, kf_display, kb_display)
    kd_label, kd_unit = ("Keq", "") if sub_order == prd_order else ("Kd", _MICROMOLAR)

    tau = 1.0 / (r.numKf + r.numKb) if (r.numKf + r.numKb) > 0 else None

    return _node(r, "reac", {
        "Kf": kf_display, "Kb": kb_display,
        "KfUnit": _rate_unit_label(sub_order, False),
        "KbUnit": _rate_unit_label(prd_order, False),
        "numKf": r.numKf, "numKb": r.numKb,
        "numKfUnit": _rate_unit_label(sub_order, True),
        "numKbUnit": _rate_unit_label(prd_order, True),
        "kd": kd, "kdLabel": kd_label, "kdUnit": kd_unit,
        "tau": tau, "tauUnit": "s",
    })


def rescale_reac_for_order_change(elem, old_sub_order, old_prd_order, changed_side):
    """Called right after a substrate/product edge add or remove has
    changed a Reac's order (see server.py's add_edge/remove_edge) -- holds
    the reaction's Kd/Keq fixed at whatever it was just before the edge
    changed, by rescaling *only* the side whose order actually changed
    (changed_side: "sub" or "prd"); the other side's raw Kf/Kb is left
    untouched. Without this, MOOSE keeps the same raw number in the
    changed field and silently reinterprets it under the new order's
    different units (Reac.Kf's units depend on order -- see
    _rate_unit_label) -- a wildly wrong jump in the reaction's actual
    kinetics, not just a display issue. A no-op if there isn't a
    meaningful Kd yet (see _kd_value) or the rescale hits a degenerate
    power (e.g. a zero Kd raised to a negative exponent).
    """
    kf_old = elem.Kf / _conc_scale(old_sub_order)
    kb_old = elem.Kb / _conc_scale(old_prd_order)
    kd = _kd_value(old_sub_order, old_prd_order, kf_old, kb_old)
    if kd is None:
        return
    new_sub_order, new_prd_order = _reac_orders(elem)
    try:
        if changed_side == "sub":
            if new_sub_order == new_prd_order:
                kf_new = kd * kb_old
            else:
                kf_new = kb_old / (kd ** (new_sub_order - new_prd_order))
            elem.Kf = kf_new * _conc_scale(new_sub_order)
        else:
            if new_sub_order == new_prd_order:
                kb_new = kf_old / kd if kd != 0 else None
            else:
                kb_new = kf_old * (kd ** (new_sub_order - new_prd_order))
            if kb_new is not None:
                elem.Kb = kb_new * _conc_scale(new_prd_order)
    except (ZeroDivisionError, OverflowError, ValueError):
        pass


def describe_enz(path):
    e = moose.element(path)
    is_mm = "MMenz" in e.className
    # Km is a plain concentration (no reaction-order dependence the way
    # Kf/Kb have) -- always a flat mM->uM conversion.
    km_display = e.Km * 1000.0
    extra = {
        "mechanism": "michaelis-menten" if is_mm else "explicit-complex",
        "KmUnit": _MICROMOLAR,
        # The parent molecule this enzyme is attached to (like a
        # ConcChan's own parentPoolId above) -- this element's own MOOSE
        # parent, not a message neighbor. Distinct from "parentId" (set
        # later, in build_graph's own loop) which instead walks up to the
        # nearest enclosing group/compartment for canvas containment.
        "parentPoolId": e.parent.path,
    }
    if is_mm:
        extra.update({"Km": km_display, "kcat": e.kcat})
    else:
        # Km/kcat/ratio exist on explicit-complex Enz too, but as derived
        # readouts of k1/k2/k3 (MOOSE recomputes them, not independently
        # settable) -- included for display, not meant to be edited here.
        # k1 is explicitly documented (Enz.cpp) as being in # units, not
        # concentration units, so it gets no uM conversion.
        extra.update({
            "k1": e.k1, "k2": e.k2, "k3": e.k3,
            "Km": km_display, "kcat": e.kcat, "ratio": e.ratio,
        })
    return _node(e, "enz", extra)


def describe_concchan(path):
    c = moose.element(path)
    in_pools = c.neighbors["in"]
    out_pools = c.neighbors["out"]
    return _node(c, "concchan", {
        "permeability": c.permeability,
        "numChan": c.numChan,
        "flux": c.flux,
        # The parent pool (like an enzyme's substrate) is structural --
        # it's this element's own MOOSE parent, not a message neighbor.
        "parentPoolId": c.parent.path,
        "inPoolId": in_pools[0].path if in_pools else None,
        "outPoolId": out_pools[0].path if out_pools else None,
    })


def _stim_field(func):
    """Which pool field (setConc/setConcInit) a Stimulus Function's
    valueOut is wired to -- read back from the live message itself (not
    re-derived from the target's current isBuffered state), so a stimulus
    keeps behaving the way it was actually built even if the target pool's
    buffered flag is changed afterward."""
    for m in func.msgOut:
        msg = moose.element(m)
        if "valueOut" in msg.srcFieldsOnE1:
            dest = msg.destFieldsOnE2[0] if msg.destFieldsOnE2 else None
            return moose.element(msg.e2).path, dest
    return None, None


def _function_inputs(f):
    """The PATHS of the molecules feeding x0, x1, ... into a Function's
    own expr, in that exact order. A Function's "x" child is a single
    Variable element holding its whole input vector -- NOT a vec of
    numVars separate elements (verified directly: indexing it by data-
    index, x[0]/x[1]/..., just aliases back to the same one element every
    time) -- so each input pool is read back off a single *repeated*
    "input" destField instead, in MESSAGE order. Relying on message order
    for "which slot is which" is the same assumption this app already
    makes elsewhere for the identical reason (model_tools.py's own
    _equation_side, reading a reaction's substrate/product neighbors
    left-to-right) -- verified directly against a legacy .g SUMTOTAL-
    derived Function (synSynth7.g's own tot_CaM_CaMKII): the two addmsg
    lines defining it appear in the file in the same order
    neighbors['input'] returns them.

    A Function built with zero inputs (a pure constant/time expression)
    has no "x" child at all -- moose.element would create a bogus new one
    if asked for a path that doesn't exist, so numVars == 0 is checked
    first rather than trying and catching."""
    if f.numVars == 0:
        return []
    x = moose.element(f.path + "/x")
    return [moose.element(n).path for n in x.neighbors["input"]]


def describe_stim(path):
    """A Function is either a genuine stimulus (drives a target pool from
    an expression with no pool inputs -- a pure constant or time-based
    driver) or a summation function (has one or more pool inputs feeding
    its own x0, x1, ... -- see _function_inputs). Both still drive a
    target pool the same way (_stim_field), but only the latter has real
    incoming connections worth drawing -- distinguished here by node type
    ("stim" vs "func") so the frontend can render/lay each out
    differently (see build_graph's own "funcInput" edges for the summation
    case)."""
    f = moose.element(path)
    target_id, dest_field = _stim_field(f)
    input_ids = _function_inputs(f)
    return _node(f, "func" if input_ids else "stim", {
        "expr": f.expr,
        "targetId": target_id,
        # "conc" / "concInit" -- stripped of the "set" prefix moose's dest
        # field names carry, to match the plain field names used elsewhere
        # in this API (e.g. describe_pool's own "conc"/"concInit" keys).
        "field": dest_field[3].lower() + dest_field[4:] if dest_field else None,
        "inputIds": input_ids,
    })


def describe_group(path, collapsed=False):
    return _node(moose.element(path), "group", {"collapsed": collapsed})


def describe_compartment(path, collapsed=False):
    c = moose.element(path)
    return _node(c, "compartment", {
        "volume": c.volume, "diameter": volume_to_diameter(c.volume), "collapsed": collapsed,
    })


def build_graph(model_path, extra_plot_windows=None, extra_collapsed=None):
    """`extra_plot_windows` (optional {live pool path: window}) is merged
    in on top of whatever detect_existing_plots finds from a legacy .g
    file's own /graphs folders -- used by load_sbml to report back
    plotWindow assignments read from this app's own custom SBML annotation
    (see server.py's _extract_plot_windows_from_sbml), since SBML has no
    native equivalent of kkit's /graphs plot tables at all.

    `extra_collapsed` (optional {live group/compartment path: bool}) is the
    same idea for a group's collapsed/expanded display state -- purely a
    frontend rendering concern (see App.jsx), with no native SBML
    representation either, read back via server.py's own
    _extract_collapsed. Defaults to expanded (False) for anything not in
    the map, which covers every legacy .g file (no such concept there) and
    a freshly created group."""
    nodes = []
    # Keyed by (from, to, type) rather than appended one entry per
    # moose.connect -- a stoichiometry > 1 reaction (e.g. "2A -> B") is
    # represented in MOOSE as *multiple separate messages* between the same
    # reac and pool (verified directly: neighbors["sub"] lists the same pool
    # once per message), which would otherwise produce fully-overlapping,
    # visually indistinguishable duplicate edges. Counting them here instead
    # lets the frontend draw one line with a stoichiometry number on it.
    edge_counts = {}

    def add_edge(frm, to, typ):
        key = (frm, to, typ)
        edge_counts[key] = edge_counts.get(key, 0) + 1

    # Compartments and groups go into `nodes` before anything else, and
    # groups are depth-sorted among themselves, so every container precedes
    # its children -- React Flow requires a parent node to appear earlier in
    # the node array than any child referencing its id via parentId.
    extra_collapsed = extra_collapsed or {}
    compartments = [moose.element(c) for c in moose.wildcardFind(model_path + "/##[CLASS=CubeMesh]")]
    for compt in compartments:
        nodes.append(describe_compartment(compt.path, extra_collapsed.get(compt.path, False)))

    groups = []
    for compt in compartments:
        # Scoped to each compartment's own subtree, not the whole model --
        # a legacy .g file's loader also creates plain Neutral folders like
        # /graphs, /moregraphs, /geometry at the model root (verified
        # directly against group_epi.g), which aren't chemistry groups and
        # sit outside any compartment, so this naturally excludes them.
        for g in moose.wildcardFind(compt.path + "/##[CLASS=Neutral]"):
            groups.append(moose.element(g))
    groups.sort(key=lambda g: g.path.count("/"))
    for g in groups:
        nodes.append(describe_group(g.path, extra_collapsed.get(g.path, False)))

    plot_windows = detect_existing_plots(model_path)
    if extra_plot_windows:
        plot_windows.update(extra_plot_windows)
    for p in moose.wildcardFind(model_path + "/##[ISA=PoolBase]"):
        p = moose.element(p)
        nodes.append(describe_pool(p.path, plot_windows.get(p.path)))

    for r in moose.wildcardFind(model_path + "/##[ISA=Reac]"):
        r = moose.element(r)
        nodes.append(describe_reac(r.path))
        for sub in r.neighbors["sub"]:
            add_edge(sub.path, r.path, "substrate")
        for prd in r.neighbors["prd"]:
            add_edge(r.path, prd.path, "product")

    for e in moose.wildcardFind(model_path + "/##[ISA=EnzBase]"):
        e = moose.element(e)
        nodes.append(describe_enz(e.path))
        # Used to read this off e.neighbors["enz"] -- but that message
        # field doesn't exist at all on an MMenz (MOOSE prints a stderr
        # warning and silently returns [] every time, verified directly
        # against Kholodenko.g, an all-MMenz model: zero "enzyme" edges
        # came out of the old loop), and is unreliably wired even on a
        # real explicit-complex Enz in some loaded .g files (a handful of
        # synSynth7.g's own enzymes had no "enz" message either). The
        # enzyme's own MOOSE tree parent -- already the reliable signal
        # describe_enz's own parentPoolId uses above -- is always its real
        # host pool for both mechanisms, so it needs no neighbor lookup at
        # all.
        add_edge(e.parent.path, e.path, "enzyme")
        for sub in e.neighbors["sub"]:
            add_edge(sub.path, e.path, "substrate")
        for prd in e.neighbors["prd"]:
            add_edge(e.path, prd.path, "product")

    for c in moose.wildcardFind(model_path + "/##[ISA=ConcChan]"):
        c = moose.element(c)
        nodes.append(describe_concchan(c.path))
        add_edge(c.parent.path, c.path, "chanParent")
        for in_pool in c.neighbors["in"]:
            add_edge(in_pool.path, c.path, "chanIn")
        for out_pool in c.neighbors["out"]:
            add_edge(c.path, out_pool.path, "chanOut")

    for f in moose.wildcardFind(model_path + "/##[ISA=Function]"):
        f = moose.element(f)
        node = describe_stim(f.path)
        nodes.append(node)
        if node["targetId"]:
            add_edge(f.path, node["targetId"], "stimTarget")
        for input_id in node["inputIds"]:
            add_edge(input_id, f.path, "funcInput")

    for node in nodes:
        node["parentId"] = container_parent_id(node["id"], model_path)

    edges = [
        {"from": frm, "to": to, "type": typ, "stoich": count}
        for (frm, to, typ), count in edge_counts.items()
    ]
    return {"nodes": nodes, "edges": edges}
