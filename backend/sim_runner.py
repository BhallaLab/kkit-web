"""Runs a MOOSE kinetic simulation to completion and returns the full time
course. Synchronous and single-threaded: the request blocks until the run
finishes, matching the rest of this backend's single-active-model design.
No streaming/threading yet -- a later iteration can add incremental
updates once the plumbing here is settled.
"""
import moose

_PLOTS_SUBPATH = "plots"
_SOLVE_TICK = 4
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
