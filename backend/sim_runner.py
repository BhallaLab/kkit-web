"""Runs a MOOSE kinetic simulation to completion and returns the full time
course. Synchronous and single-threaded: the request blocks until the run
finishes, matching the rest of this backend's single-active-model design.
No streaming/threading yet -- a later iteration can add incremental
updates once the plumbing here is settled.
"""
import moose

_PLOTS_SUBPATH = "plots"
_SOLVE_TICK = 4
_FUNC_TICK = 6
_DEFAULT_SIMDT = 0.01


def _plots_path(model_path):
    return f"{model_path}/{_PLOTS_SUBPATH}"


def _compartment_path(model_path):
    kinetics = model_path + "/kinetics"
    return kinetics if moose.exists(kinetics) else model_path


def build_solver(model_path, plot_dt):
    """(Re)builds the Ksolve/Dsolve/Stoich trio that actually drives the
    reaction system -- moose.loadModel(..., 'ee') only parses the model and
    leaves every Pool/Reac/Enz unscheduled (tick=-1); 'ee' is a legacy mode
    meant for loading, not computation. Rebuilt fresh on every run (deleting
    any previous solver first) so Stoich.reacSystemPath -- which captures the
    reaction system as a one-shot scan, not a live view -- always reflects
    the model's current objects, including any added/removed since the last
    run. Mirrors the pattern in jardesigner/jardesigner.py's _buildChemLine.

    Without an explicit moose.useClock/setClock here, Ksolve/Dsolve fall back
    to whatever MOOSE's default tick dt happens to be -- verified directly to
    be coarser than a typical plot_dt, which made the recorded concentration
    hold the same value for several plot samples in a row (a real staircase
    in the data, not a Plotly rendering choice) before jumping to the next
    actual solver update. Scheduling them onto tick 4 with a dt clamped to a
    fraction of plot_dt guarantees the solver always advances several times
    between plot samples, so the recorded trace is actually smooth.
    """
    compt_path = _compartment_path(model_path)
    for name in ("stoich", "ksolve", "dsolve"):
        p = f"{compt_path}/{name}"
        if moose.exists(p):
            moose.delete(p)

    ksolve = moose.Ksolve(f"{compt_path}/ksolve")
    dsolve = moose.Dsolve(f"{compt_path}/dsolve")
    stoich = moose.Stoich(f"{compt_path}/stoich")
    stoich.compartment = moose.element(compt_path)
    stoich.ksolve = ksolve
    stoich.dsolve = dsolve
    stoich.reacSystemPath = compt_path + "/##"

    simdt = min(_DEFAULT_SIMDT, plot_dt / 10)
    moose.setClock(_SOLVE_TICK, simdt)
    moose.useClock(_SOLVE_TICK, ksolve.path, "process")
    moose.useClock(_SOLVE_TICK, dsolve.path, "process")

    # A Stimulus's Function drives its target pool's conc/concInit every
    # timestep, not just once at reinit -- explicit scheduling here (rather
    # than relying on whatever default tick a freshly-created Function
    # happens to fall on) matches how the solver itself is explicitly
    # scheduled just above, and guarantees the expression is actually
    # re-evaluated at simdt resolution throughout the run.
    moose.setClock(_FUNC_TICK, simdt)
    moose.useClock(_FUNC_TICK, compt_path + "/##[ISA=Function]", "process")


def build_plot_tables(model_path):
    """(Re)builds one Table2 per currently-live pool, wired to its conc.
    Rebuilt fresh on every run so the table set always matches the model's
    current pools -- pools added/removed/renamed since the last run are
    picked up automatically instead of working off a stale set."""
    path = _plots_path(model_path)
    if moose.exists(path):
        moose.delete(path)
    moose.Neutral(path)

    tables = {}
    for i, p in enumerate(moose.wildcardFind(model_path + "/##[ISA=PoolBase]")):
        p = moose.element(p)
        tab = moose.Table2(f"{path}/t{i}")
        moose.connect(tab, "requestOut", p, "getConc")
        tables[p.path] = tab
    return tables


_COARSE_MULTIPLIERS = [1, 2, 5]
_FINE_MULTIPLIERS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8]

# Ported from xdoser.g's own 8 concentration-range toggle buttons -- decade
# 0 is 0.1 nM (1e-7 mM, matching this app's mM-valued concInit), each
# subsequent decade x10.
DOSE_DECADE_LABELS = ["0.1 nM", "1 nM", "10 nM", "100 nM", "1 µM", "10 µM", "100 µM", "1 mM"]


def dose_concentrations(min_decade, max_decade, fine):
    """Log-spaced concentrations (mM) spanning decades [min_decade,
    max_decade] inclusive -- the same "1-2-5" (coarse, 3/decade) or
    "1-1.2-1.5-2-2.5-3-4-5-6-8" (fine, 10/decade) per-decade spacing
    xdoser.g's own hardcoded 22- and 72-entry tables used, generalized to
    any decade range instead of a fixed table."""
    multipliers = _FINE_MULTIPLIERS if fine else _COARSE_MULTIPLIERS
    concs = []
    for decade in range(min_decade, max_decade + 1):
        base = 10.0 ** (decade - 7)
        concs.extend(base * m for m in multipliers)
    return concs


def start_dose_response(model_path, input_id, output_id, concs, runtime, buffered, reset_each_level, plot_dt):
    """Sets up one dose-response *session* -- ported from xdoser.g's
    do_doser, but broken into a distinct step per dose level (see
    step_dose_response) rather than one all-in-one blocking loop, so the
    frontend can show progress and let the user halt between levels
    (mirroring the original's own Halt button, which likewise only ever
    took effect at the next do_run boundary, not mid-run).

    Builds the solver once up front (this is one continuous series, not
    independent runs) and snapshots the input pool's original concInit/
    isBuffered so step_dose_response's caller can restore them via
    finish_dose_response once the series ends or is halted."""
    build_solver(model_path, plot_dt)
    input_pool = moose.element(input_id)
    moose.reinit()
    return {
        "model_path": model_path,
        "input_id": input_id,
        "output_id": output_id,
        "concs": concs,
        "index": 0,
        "runtime": runtime,
        "buffered": buffered,
        "reset_each_level": reset_each_level,
        "orig_conc_init": input_pool.concInit,
        "orig_buffered": bool(input_pool.isBuffered),
        "last_conc": 0.0,
    }


def step_dose_response(session):
    """Runs exactly one dose level -- one distinct moose.start() call, as
    many as concs -- and returns its (conc, response) result, or None once
    every level has been run. "buffered" forces the input pool's concInit
    and holds it fixed (isBuffered) at each level, exactly like a molecule
    under experimental clamp; otherwise each level *adds* the level-to-
    level concentration delta to the pool's live conc (an "incremented"/
    injected dose) rather than resetting it outright. "reset_each_level"
    reinits the whole model before this level (a fresh run from that
    baseline) instead of letting the system evolve continuously from the
    previous level's end state."""
    index = session["index"]
    concs = session["concs"]
    if index >= len(concs):
        return None
    conc = concs[index]
    input_pool = moose.element(session["input_id"])
    output_pool = moose.element(session["output_id"])
    if session["buffered"]:
        input_pool.concInit = conc
        input_pool.isBuffered = True
        if session["reset_each_level"]:
            moose.reinit()
    elif session["reset_each_level"]:
        input_pool.concInit = conc
        moose.reinit()
    else:
        input_pool.conc = input_pool.conc + conc - session["last_conc"]
    moose.start(session["runtime"])
    session["last_conc"] = conc
    session["index"] = index + 1
    return {"conc": conc, "response": float(output_pool.conc)}


def finish_dose_response(session):
    """Restores the input pool's original concInit/isBuffered -- called
    once the series completes (step_dose_response returns None) or the
    user halts early, the same way the original tool put CoInit/
    slave_enable back afterward."""
    input_pool = moose.element(session["input_id"])
    input_pool.concInit = session["orig_conc_init"]
    input_pool.isBuffered = session["orig_buffered"]


def run_simulation(model_path, runtime, plot_dt):
    build_solver(model_path, plot_dt)
    tables = build_plot_tables(model_path)
    moose.setClock(8, plot_dt)
    moose.useClock(8, _plots_path(model_path) + "/##", "process")
    moose.reinit()
    moose.start(runtime)

    n_samples = len(next(iter(tables.values())).vector) if tables else 0
    time = [round(i * plot_dt, 9) for i in range(n_samples)]
    series = {pool_path: [float(v) for v in tab.vector] for pool_path, tab in tables.items()}
    return {"time": time, "series": series}
