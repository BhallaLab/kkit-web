"""Extract a node/edge graph description from a live MOOSE chemical model.

This is NOT a persisted file format -- it's just the API response shape used
to draw the React Flow canvas. Persistence goes through moose.loadModel
(legacy .g import) and moose.writeSBML/readSBML (native save/load).
"""
import moose


def _info(path):
    if not moose.exists(path + "/info"):
        return {"x": 0.0, "y": 0.0, "color": "white", "textColor": "black", "notes": ""}
    info = moose.element(path + "/info")
    return {
        "x": info.x,
        "y": info.y,
        "color": info.color,
        "textColor": info.textColor,
        "notes": info.notes,
    }


def create_info(path, x, y, color="white", notes=""):
    info = moose.Annotator(path + "/info")
    info.x = x
    info.y = y
    info.color = color
    info.textColor = "black"
    info.notes = notes
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


def describe_pool(path):
    p = moose.element(path)
    return _node(p, "pool", {
        "n": p.n,
        "nInit": p.nInit,
        "conc": p.conc,
        "concInit": p.concInit,
        "diffConst": p.diffConst,
        "motorConst": p.motorConst,
        "volume": p.volume,
        "isBuffered": p.isBuffered,
    })


def describe_reac(path):
    r = moose.element(path)
    # Kf/Kb (concentration.time units) and numKf/numKb (number.time units)
    # are both native MOOSE fields, kept in sync internally -- no manual
    # unit-conversion math needed to show both.
    return _node(r, "reac", {"Kf": r.Kf, "Kb": r.Kb, "numKf": r.numKf, "numKb": r.numKb})


def describe_enz(path):
    e = moose.element(path)
    is_mm = "MMenz" in e.className
    extra = {"mechanism": "michaelis-menten" if is_mm else "explicit-complex"}
    if is_mm:
        extra.update({"Km": e.Km, "kcat": e.kcat})
    else:
        # Km/kcat/ratio exist on explicit-complex Enz too, but as derived
        # readouts of k1/k2/k3 (MOOSE recomputes them, not independently
        # settable) -- included for display, not meant to be edited here.
        extra.update({
            "k1": e.k1, "k2": e.k2, "k3": e.k3,
            "Km": e.Km, "kcat": e.kcat, "ratio": e.ratio,
        })
    return _node(e, "enz", extra)


def build_graph(model_path):
    nodes = []
    edges = []

    for p in moose.wildcardFind(model_path + "/##[ISA=PoolBase]"):
        p = moose.element(p)
        nodes.append(describe_pool(p.path))

    for r in moose.wildcardFind(model_path + "/##[ISA=Reac]"):
        r = moose.element(r)
        nodes.append(describe_reac(r.path))
        for sub in r.neighbors["sub"]:
            edges.append({"from": sub.path, "to": r.path, "type": "substrate"})
        for prd in r.neighbors["prd"]:
            edges.append({"from": r.path, "to": prd.path, "type": "product"})

    for e in moose.wildcardFind(model_path + "/##[ISA=EnzBase]"):
        e = moose.element(e)
        nodes.append(describe_enz(e.path))
        for enzParent in e.neighbors["enz"]:
            edges.append({"from": enzParent.path, "to": e.path, "type": "enzyme"})
        for sub in e.neighbors["sub"]:
            edges.append({"from": sub.path, "to": e.path, "type": "substrate"})
        for prd in e.neighbors["prd"]:
            edges.append({"from": e.path, "to": prd.path, "type": "product"})

    for c in moose.wildcardFind(model_path + "/##[ISA=ConcChan]"):
        c = moose.element(c)
        nodes.append(_node(c, "concchan"))

    return {"nodes": nodes, "edges": edges}
