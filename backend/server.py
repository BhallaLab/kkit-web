import itertools
import os
import tempfile

import moose
from flask import Flask, jsonify, request
from flask_cors import CORS

from moose_graph import build_graph, describe_pool, describe_reac, describe_enz, create_info

app = Flask(__name__)
CORS(app)

_path_counter = itertools.count()
_current_model_path = None


def _new_model_path():
    """A fresh, never-before-used moose path for each load, so concurrent or
    repeated loads (e.g. React StrictMode's double effect invocation in dev)
    never collide with leftover state from a previous load."""
    global _current_model_path
    _current_model_path = f"/model_{next(_path_counter)}"
    return _current_model_path


@app.errorhandler(Exception)
def handle_error(err):
    app.logger.exception("request failed")
    return jsonify({"error": str(err)}), 500


@app.post("/api/load_gfile")
def load_gfile():
    """Load a legacy kkit .g file by server-side path (dev convenience;
    a real upload endpoint would take multipart file data instead)."""
    path = request.json.get("path")
    if not path or not os.path.isfile(path):
        return jsonify({"error": f"file not found: {path}"}), 400
    model_path = _new_model_path()
    moose.loadModel(path, model_path, "ee")
    return jsonify(build_graph(model_path))


@app.get("/api/graph")
def get_graph():
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    return jsonify(build_graph(_current_model_path))


def _update_node(node_id, fields, numeric_fields, bool_fields, describe_fn):
    if _current_model_path is None or not node_id or not node_id.startswith(_current_model_path):
        return jsonify({"error": "invalid or stale node id"}), 400
    if not moose.exists(node_id):
        return jsonify({"error": f"node not found: {node_id}"}), 404

    elem = moose.element(node_id)
    # `info` is a live object reference, not a path string -- it stays valid
    # even after the rename below changes elem's (and info's) own .path.
    info = moose.element(node_id + "/info")

    new_name = fields.get("name")
    if new_name and new_name != elem.name:
        elem.name = new_name

    for key, value in fields.items():
        if key in numeric_fields:
            setattr(elem, key, float(value))
        elif key in bool_fields:
            setattr(elem, key, bool(value))
        elif key in ("color", "notes"):
            setattr(info, key, value)

    result = describe_fn(elem.path)
    result["previousId"] = node_id
    return jsonify(result)


_POOL_SIM_FIELDS = {"n", "nInit", "conc", "concInit", "diffConst", "motorConst"}


@app.post("/api/update_pool")
def update_pool():
    body = request.json or {}
    return _update_node(
        body.get("id"), body.get("fields", {}), _POOL_SIM_FIELDS, {"isBuffered"}, describe_pool
    )


_REAC_SIM_FIELDS = {"Kf", "Kb", "numKf", "numKb"}


@app.post("/api/update_reac")
def update_reac():
    body = request.json or {}
    return _update_node(
        body.get("id"), body.get("fields", {}), _REAC_SIM_FIELDS, set(), describe_reac
    )


_ENZ_SIM_FIELDS = {
    "explicit-complex": {"k1", "k2", "k3"},
    "michaelis-menten": {"Km", "kcat"},
}


@app.post("/api/update_enz")
def update_enz():
    body = request.json or {}
    node_id = body.get("id")
    if _current_model_path is None or not node_id or not node_id.startswith(_current_model_path):
        return jsonify({"error": "invalid or stale node id"}), 400
    if not moose.exists(node_id):
        return jsonify({"error": f"node not found: {node_id}"}), 404

    mechanism = "michaelis-menten" if "MMenz" in moose.element(node_id).className else "explicit-complex"
    return _update_node(node_id, body.get("fields", {}), _ENZ_SIM_FIELDS[mechanism], set(), describe_enz)


@app.post("/api/update_position")
def update_position():
    body = request.json or {}
    node_id = body.get("id")
    if _current_model_path is None or not node_id or not node_id.startswith(_current_model_path):
        return jsonify({"error": "invalid or stale node id"}), 400
    if not moose.exists(node_id) or not moose.exists(node_id + "/info"):
        return jsonify({"error": f"node or info not found: {node_id}"}), 404

    info = moose.element(node_id + "/info")
    info.x = float(body.get("x"))
    info.y = float(body.get("y"))
    return jsonify({"ok": True, "x": info.x, "y": info.y})


def _validate_edge_ids(from_id, to_id):
    if _current_model_path is None or not from_id or not to_id:
        return "missing from/to"
    if not (from_id.startswith(_current_model_path) and to_id.startswith(_current_model_path)):
        return "invalid or stale node id"
    if not moose.exists(from_id) or not moose.exists(to_id):
        return "node not found"
    return None


@app.post("/api/add_edge")
def add_edge():
    """Mirrors kkit's drag-to-connect gesture: 'substrate' wires a pool as
    input to a Reac/Enz, 'product' wires a Reac/Enz's output to a pool."""
    body = request.json or {}
    from_id, to_id, edge_type = body.get("from"), body.get("to"), body.get("type")
    err = _validate_edge_ids(from_id, to_id)
    if err:
        return jsonify({"error": err}), 400

    if edge_type == "substrate":
        moose.connect(moose.element(to_id), "sub", moose.element(from_id), "reac")
    elif edge_type == "product":
        moose.connect(moose.element(from_id), "prd", moose.element(to_id), "reac")
    else:
        return jsonify({"error": f"unsupported edge type: {edge_type}"}), 400

    return jsonify({"ok": True})


_EDGE_SRC_FIELD = {"substrate": "subOut", "product": "prdOut"}


@app.post("/api/remove_edge")
def remove_edge():
    body = request.json or {}
    from_id, to_id, edge_type = body.get("from"), body.get("to"), body.get("type")
    if edge_type not in _EDGE_SRC_FIELD:
        return jsonify({"error": f"unsupported edge type: {edge_type}"}), 400
    err = _validate_edge_ids(from_id, to_id)
    if err:
        return jsonify({"error": err}), 400

    reac_or_enz_id = to_id if edge_type == "substrate" else from_id
    pool_id = from_id if edge_type == "substrate" else to_id
    src_field = _EDGE_SRC_FIELD[edge_type]

    for m in moose.element(reac_or_enz_id).msgOut:
        msg = moose.element(m)
        if src_field in msg.srcFieldsOnE1 and moose.element(msg.e2).path == pool_id:
            moose.delete(msg)
            return jsonify({"ok": True})

    return jsonify({"error": "connection not found"}), 404


def _container_path():
    """New pools/reacs are created alongside the model's existing objects --
    under its 'kinetics' compartment if there is one, else at the model root."""
    kinetics = _current_model_path + "/kinetics"
    return kinetics if moose.exists(kinetics) else _current_model_path


def _unique_name(container, base):
    name = base
    i = 1
    while moose.exists(f"{container}/{name}"):
        i += 1
        name = f"{base}{i}"
    return name


@app.post("/api/create_pool")
def create_pool():
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    body = request.json or {}
    container = _container_path()
    name = _unique_name(container, body.get("name") or "pool")
    p = moose.Pool(f"{container}/{name}")
    p.concInit = 0.001
    create_info(p.path, float(body.get("x", 0)), float(body.get("y", 0)))
    return jsonify(describe_pool(p.path))


@app.post("/api/create_reac")
def create_reac():
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    body = request.json or {}
    container = _container_path()
    name = _unique_name(container, body.get("name") or "reac")
    r = moose.Reac(f"{container}/{name}")
    r.Kf, r.Kb = 0.1, 0.1
    create_info(r.path, float(body.get("x", 0)), float(body.get("y", 0)))
    return jsonify(describe_reac(r.path))


@app.post("/api/create_enz")
def create_enz():
    """kkit requires an enzyme to be structurally nested under its parent
    pool, unlike Reac's plain message-based sub/prd wiring, so this needs an
    explicit parent rather than being addable via the generic add_edge flow."""
    body = request.json or {}
    parent_id = body.get("parentPoolId")
    if _current_model_path is None or not parent_id or not parent_id.startswith(_current_model_path):
        return jsonify({"error": "invalid or missing parent pool"}), 400
    if not moose.exists(parent_id):
        return jsonify({"error": f"parent pool not found: {parent_id}"}), 404

    parent = moose.element(parent_id)
    name = _unique_name(parent_id, body.get("name") or "enz")
    e = moose.Enz(f"{parent_id}/{name}")
    e.k1, e.k2, e.k3 = 1.0, 1.0, 1.0
    moose.connect(e, "enz", parent, "reac")
    cplx = moose.Pool(f"{e.path}/{name}_cplx")
    moose.connect(e, "cplx", cplx, "reac")

    x, y = float(body.get("x", 0)), float(body.get("y", 0))
    create_info(e.path, x, y)
    create_info(cplx.path, x + 0.5, y - 0.5)
    return jsonify(describe_enz(e.path))


@app.post("/api/delete_node")
def delete_node():
    body = request.json or {}
    node_id = body.get("id")
    if _current_model_path is None or not node_id or not node_id.startswith(_current_model_path):
        return jsonify({"error": "invalid or stale node id"}), 400
    if not moose.exists(node_id):
        return jsonify({"error": f"node not found: {node_id}"}), 404
    moose.delete(node_id)
    return jsonify({"ok": True})


@app.post("/api/save_sbml")
def save_sbml():
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    fd, path = tempfile.mkstemp(suffix=".xml")
    os.close(fd)
    moose.writeSBML(_current_model_path, path)
    with open(path) as f:
        content = f.read()
    os.remove(path)
    return jsonify({"sbml": content})


@app.post("/api/load_sbml")
def load_sbml():
    content = request.json.get("sbml")
    if not content:
        return jsonify({"error": "no sbml content provided"}), 400
    fd, path = tempfile.mkstemp(suffix=".xml")
    with os.fdopen(fd, "w") as f:
        f.write(content)
    model_path = _new_model_path()
    moose.readSBML(path, model_path)
    os.remove(path)
    return jsonify(build_graph(model_path))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True)
