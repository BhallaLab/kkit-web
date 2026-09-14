"""Runs a FindSim experiment spec against the currently loaded model.

This is NOT the FindSim python package -- it's a small, purpose-built
reader for exactly the slice of FindSim-Schema.json this app can act on:
Experiment.design (TimeSeries or DoseResponse only), Stimuli, and Readouts.
Everything else in the schema (Modifications/model-subsetting, BarChart,
DirectParameter, HillTau, entity identifier-type lookups, Metadata.
testModel auto-loading) is deliberately out of scope -- kkit-web already
has its own model-editing and Dose Response machinery, and pulling in the
real FindSim package would mean carrying its file-based/matplotlib-
oriented CLI harness for a feature that only needs two of its several
experiment designs. Unit tables and the two designs' execution shapes are
ported by reading findSim.py/simWrapMoose.py directly (see convertQuantityUnits,
convertTimeUnits, runDoser/steadyStateStims, and parseAndRun's own event
queue), not guessed at.
"""
import math

import moose

from moose_graph import is_enz_complex
from sim_runner import build_solver, start_dose_response, step_dose_response, finish_dose_response


class FindSimError(Exception):
    pass


# -> seconds. Mirrors findSim.py's own convertTimeUnits, trimmed to the
# units FindSim-Schema.json actually allows for timeUnits.
_TIME_UNIT_SCALE = {
    "s": 1.0, "sec": 1.0,
    "ms": 1e-3, "msec": 1e-3,
    "us": 1e-6, "usec": 1e-6,
    "min": 60.0, "hr": 3600.0, "day": 86400.0,
}

# -> mM, this app's (and MOOSE's) native pool concentration unit. Mirrors
# findSim.py's own convertQuantityUnits, trimmed to what a chemical-kinetics
# model actually has fields for -- kkit-web has no electrical/synaptic
# compartments, so V/A/Hz aren't included.
_QUANTITY_UNIT_SCALE = {
    "M": 1e3, "mM": 1.0, "uM": 1.0e-3, "nM": 1.0e-6,
    "#": 1.0, "ratio": 1.0,
}

# Stimuli.field's schema enum is mostly electrical/synaptic
# (Vm/Vclamp/rate/weight/EPSP_peak/synInput) -- none of that has a
# matching object in a pure chemical-kinetics model.
_SUPPORTED_STIM_FIELDS = {"conc"}
# Readouts.field is an unconstrained string in the schema; in practice
# it's "conc" (occasionally "n").
_SUPPORTED_READOUT_FIELDS = {"conc", "n"}


def _entity(block):
    e = block.get("entity") or {}
    return e.get("name"), e.get("alias")


def parse_findsim_spec(spec):
    """Validates and normalizes a parsed FindSim JSON file into the small
    shape the rest of this module needs, raising FindSimError (a plain,
    user-facing message) the moment something outside kkit-web's scope
    shows up, rather than silently ignoring it."""
    if not isinstance(spec, dict):
        raise FindSimError("not a valid FindSim experiment file (not a JSON object)")

    design = ((spec.get("Experiment") or {}).get("design"))
    if design not in ("TimeSeries", "DoseResponse"):
        raise FindSimError(
            f"Experiment.design '{design}' isn't supported here -- only "
            "TimeSeries and DoseResponse are (BarChart/DirectParameter aren't)"
        )

    stimuli_raw = spec.get("Stimuli")
    if not stimuli_raw:
        raise FindSimError("this file has no Stimuli block")
    readout_raw = spec.get("Readouts")
    if not readout_raw:
        raise FindSimError("this file has no Readouts block")

    stimuli = []
    for i, s in enumerate(stimuli_raw):
        field = s.get("field")
        if field not in _SUPPORTED_STIM_FIELDS:
            raise FindSimError(
                f"Stimuli[{i}].field '{field}' isn't supported -- kkit-web is a "
                "chemical-kinetics editor with no electrical/synaptic model"
            )
        qu = s.get("quantityUnits")
        if qu not in _QUANTITY_UNIT_SCALE:
            raise FindSimError(f"Stimuli[{i}].quantityUnits '{qu}' isn't supported")
        name, alias = _entity(s)
        data = s.get("data")
        if not data and s.get("value") is not None:
            # A bare constant (no time-course) -- treated as a single
            # held-from-t=0 step, same as a one-row data array.
            data = [[0, s["value"]]]
        stimuli.append({
            "id": f"stim{i}",
            "entityName": name,
            "alias": alias,
            "field": field,
            "quantityUnits": qu,
            "timeUnits": s.get("timeUnits"),
            "data": data,
        })

    field = readout_raw.get("field")
    if field not in _SUPPORTED_READOUT_FIELDS:
        raise FindSimError(f"Readouts.field '{field}' isn't supported")
    qu = readout_raw.get("quantityUnits")
    if qu not in _QUANTITY_UNIT_SCALE:
        raise FindSimError(f"Readouts.quantityUnits '{qu}' isn't supported")
    tu = readout_raw.get("timeUnits")
    if tu not in _TIME_UNIT_SCALE:
        raise FindSimError(f"Readouts.timeUnits '{tu}' isn't supported")
    data = readout_raw.get("data")
    if not data:
        raise FindSimError(
            "Readouts.data is required -- bardata (BarChart) and paramdata "
            "(DirectParameter) experiments aren't supported"
        )
    name, alias = _entity(readout_raw)
    settle_time = readout_raw.get("settleTime")

    if design == "DoseResponse":
        if len(stimuli) != 1:
            raise FindSimError(
                f"DoseResponse needs exactly one Stimuli block, {len(stimuli)} given"
            )
        if not settle_time:
            raise FindSimError("Readouts.settleTime is required for a DoseResponse experiment")

    readout = {
        "id": "readout",
        "entityName": name,
        "alias": alias,
        "field": field,
        "quantityUnits": qu,
        "timeUnits": tu,
        "data": data,
        "settleTime": settle_time,
    }
    return {"design": design, "stimuli": stimuli, "readout": readout}


def resolve_entities(parsed, model_path):
    """Matches each Stimuli/Readouts entity's name (then alias) against a
    pool name in the *currently loaded* model -- exact string match only,
    no testMap-style renaming (out of scope, see module docstring). Ties
    are broken by whichever pool wildcardFind visits first; ambiguous
    naming is the user's own model's business, same as anywhere else this
    app looks objects up by name. Returns {block id: pool path or None} and
    the full list of candidate pools for a manual-mapping UI to offer."""
    pools = {}
    pool_options = []
    for p in moose.wildcardFind(model_path + "/##[ISA=PoolBase]"):
        p = moose.element(p)
        if is_enz_complex(p.path):
            continue
        pools.setdefault(p.name, p.path)
        pool_options.append({"id": p.path, "name": p.name})

    def resolve(block):
        for key in (block["entityName"], block["alias"]):
            if key and key in pools:
                return pools[key]
        return None

    matched = {s["id"]: resolve(s) for s in parsed["stimuli"]}
    matched[parsed["readout"]["id"]] = resolve(parsed["readout"])
    return matched, pool_options


def _nrms(sim_points, expt_points):
    """Normalized RMS score, exactly as findSim.py's doScore computes it
    for scoringFormula "NRMS": sqrt(mean((expt-sim)^2)) / datarange, where
    datarange is the largest value seen in either curve (so a close-to-flat
    experiment doesn't produce a spuriously huge score from a tiny
    denominator)."""
    if not sim_points or len(sim_points) != len(expt_points):
        return None
    datarange = max(v for _, v in sim_points)
    sq = 0.0
    for (_, sim), expt_row in zip(sim_points, expt_points):
        expt = expt_row[1]
        datarange = max(datarange, expt)
        sq += (expt - sim) ** 2
    rms = math.sqrt(sq / len(sim_points))
    return rms / datarange if datarange > 1e-6 else rms


def _expt_points(readout):
    return [[row[0], row[1], row[2] if len(row) > 2 else 0.0] for row in readout["data"]]


def run_findsim_timeseries(model_path, parsed, entity_map):
    """Ported from findSim.py's parseAndRun: merges every Stimuli data
    point and every Readouts data point into one time-sorted checkpoint
    list, then steps moose.start() through them exactly like FindSim's own
    event queue -- deliver a stimulus (setting .conc, and at t<=0 also
    .concInit + reinit, matching deliverStim's own t==0 special case), or
    sample the readout pool's current field value at that exact instant.
    Comparison is always at the experiment's own time points, no
    interpolation. isBuffered isn't force-applied here -- FindSim itself
    only forces it for DoseResponse/BarChart (findSim.py:1702), leaving
    TimeSeries stimuli to whatever the model's own pools are already
    configured as."""
    stimuli = parsed["stimuli"]
    readout = parsed["readout"]

    stim_pools = []
    for s in stimuli:
        pool_id = entity_map.get(s["id"])
        if not pool_id:
            raise FindSimError(f"no pool selected for stimulus entity '{s['entityName']}'")
        stim_pools.append(moose.element(pool_id))
    out_id = entity_map.get(readout["id"])
    if not out_id:
        raise FindSimError(f"no pool selected for readout entity '{readout['entityName']}'")
    out_pool = moose.element(out_id)

    # Plain default simdt -- readouts are sampled directly off the pool's
    # live value at each checkpoint (see build_solver's own docstring), not
    # off a recorded Table2 trace, so there's nothing for a finer dt to
    # smooth out here.
    build_solver(model_path)

    # (time, priority, kind, pool, value) -- priority 0 (stim) sorts before
    # 1 (read) at equal t, so a readout landing on the same instant as a
    # stimulus sees the value it just set, mirroring FindSim's own
    # Stimulus-before-Readout tie-break in its priority queue.
    events = []
    for s, pool in zip(stimuli, stim_pools):
        scale = _QUANTITY_UNIT_SCALE[s["quantityUnits"]]
        tscale = _TIME_UNIT_SCALE.get(s["timeUnits"], 1.0)
        for t, v in s["data"] or []:
            events.append((t * tscale, 0, pool, v * scale))
    readout_tscale = _TIME_UNIT_SCALE[readout["timeUnits"]]
    for row in readout["data"]:
        events.append((row[0] * readout_tscale, 1, None, None))
    events.sort(key=lambda e: (e[0], e[1]))

    moose.reinit()
    sim_points = []
    current_t = 0.0
    read_field = readout["field"]
    for t, priority, pool, value in events:
        if t > current_t:
            moose.start(t - current_t)
            current_t = t
        if priority == 0:
            pool.conc = value
            if t <= 0.0:
                pool.concInit = value
                moose.reinit()
                current_t = 0.0
        else:
            raw = out_pool.conc if read_field == "conc" else out_pool.n
            sim_points.append([t, raw])

    readout_scale = _QUANTITY_UNIT_SCALE[readout["quantityUnits"]]
    sim_display = [[t, v / readout_scale] for t, v in sim_points]
    expt = _expt_points(readout)
    return {
        "design": "TimeSeries",
        "xLabel": f"time ({readout['timeUnits']})",
        "yLabel": f"{readout['entityName']} {readout['field']} ({readout['quantityUnits']})",
        "simPoints": sim_display,
        "exptPoints": expt,
        "score": _nrms(sim_display, expt),
    }


def run_findsim_doseresponse(model_path, parsed, entity_map):
    """Ported from findSim.py's runDoser/steadyStateStims (isSeries=True):
    the dose levels come from Readouts.data's own first column, each value
    interpreted in the *stimulus's* quantityUnits (verified directly in
    findSim.py:1299 -- a non-obvious detail, the dose axis is stored under
    Readouts but scaled by the Stimuli block). Reuses this app's own Dose
    Response session machinery verbatim -- a FindSim dose-response run is
    exactly one continuous series (no per-level reinit, held buffered)
    against explicit levels instead of a decade sweep, which
    start_dose_response already supports directly."""
    stim = parsed["stimuli"][0]
    readout = parsed["readout"]
    in_id = entity_map.get(stim["id"])
    if not in_id:
        raise FindSimError(f"no pool selected for stimulus entity '{stim['entityName']}'")
    out_id = entity_map.get(readout["id"])
    if not out_id:
        raise FindSimError(f"no pool selected for readout entity '{readout['entityName']}'")

    stim_scale = _QUANTITY_UNIT_SCALE[stim["quantityUnits"]]
    concs = [row[0] * stim_scale for row in readout["data"]]

    session = start_dose_response(
        model_path, in_id, out_id, concs,
        runtime=readout["settleTime"], buffered=True, reset_each_level=False,
    )
    sim_points = []
    while True:
        step = step_dose_response(session)
        if step is None:
            break
        sim_points.append(step)
    finish_dose_response(session)

    readout_scale = _QUANTITY_UNIT_SCALE[readout["quantityUnits"]]
    sim_display = [[row[0], p["response"] / readout_scale] for row, p in zip(readout["data"], sim_points)]
    expt = _expt_points(readout)
    return {
        "design": "DoseResponse",
        "xLabel": f"{stim['entityName']} dose ({stim['quantityUnits']})",
        "yLabel": f"{readout['entityName']} {readout['field']} ({readout['quantityUnits']})",
        "simPoints": sim_display,
        "exptPoints": expt,
        "score": _nrms(sim_display, expt),
    }


def run_findsim(model_path, parsed, entity_map):
    if parsed["design"] == "TimeSeries":
        return run_findsim_timeseries(model_path, parsed, entity_map)
    return run_findsim_doseresponse(model_path, parsed, entity_map)
