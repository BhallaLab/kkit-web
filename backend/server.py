import html
import itertools
import json
import os
import re
import subprocess
import sys
import tempfile

import libsbml
import moose
from flask import Flask, jsonify, request
from flask_cors import CORS

from moose_graph import (
    build_graph,
    describe_pool,
    describe_reac,
    describe_enz,
    describe_group,
    describe_compartment,
    describe_concchan,
    describe_stim,
    create_info,
    is_enz_complex,
    container_parent_id,
    _CONTAINER_CLASSES,
    diameter_to_volume,
    name_path,
    normalize_color,
    _stim_field,
    _function_inputs,
    set_func_expr,
    clean_func_expr,
    _reac_orders,
    _conc_scale,
    rescale_reac_for_order_change,
)
from sim_runner import (
    run_simulation,
    start_dose_response,
    step_dose_response,
    finish_dose_response,
    dose_concentrations,
    DOSE_DECADE_LABELS,
)
from model_tools import model_size, find_dt, compare_groups, render_report
from findsim_runner import FindSimError, parse_findsim_spec, resolve_entities, run_findsim

_NOTES_BODY_RE = re.compile(r"<body[^>]*>\s*<p>(.*?)</p>\s*</body>", re.DOTALL)


def _wrap_notes(text):
    """Plain text -> a valid SBML <notes> element (an XHTML fragment, as the
    spec requires) attached to the model, so free-text notes ride along with
    the model inside the same .xml file rather than needing a side channel."""
    escaped = html.escape(text).replace("\n", "<br/>")
    return f'<notes><body xmlns="http://www.w3.org/1999/xhtml"><p>{escaped}</p></body></notes>'


# A legacy kkit .g file's own model-level notes -- verified directly against
# a real dump (Repressillator.g): `simundump text /kinetics/notes 0 "..."`,
# the SAME simundump-a-text-object convention every per-group/per-reaction
# "notes" field also uses (e.g. `/kinetics/lac_gene/notes`), just at the
# model's own top level. moose.loadModel's own 'ee' GENESIS parser silently
# DROPS this entirely -- verified directly, no "notes" child or field
# exists anywhere on the loaded object tree afterward -- so this has to be
# pulled from the raw uploaded text instead, the same way this app already
# treats moose's own SBML writer as unable to round-trip a model-level
# extra (see _inject_stim_annotations' own docstring).
_G_LINE_CONTINUATION_RE = re.compile(r"\\\s*\r?\n\s*")
_G_MODEL_NOTES_RE = re.compile(r'simundump\s+text\s+/kinetics/notes\s+\d+\s+"((?:[^"\\]|\\.)*)"')
_G_ESCAPE_RE = re.compile(r"\\(.)")


def _unescape_g_string(s):
    # GENESIS's own dump escaping: \n/\t for the obvious whitespace, \" so a
    # literal quote doesn't end the string early, \\ for a literal
    # backslash -- and, same as a plain \\(anything else), just drops the
    # backslash for anything not specifically meaningful.
    return _G_ESCAPE_RE.sub(lambda m: {"n": "\n", "t": "\t"}.get(m.group(1), m.group(1)), s)


def _extract_g_model_notes(content):
    joined = _G_LINE_CONTINUATION_RE.sub(" ", content)
    m = _G_MODEL_NOTES_RE.search(joined)
    return _unescape_g_string(m.group(1)) if m else ""


_GROUP_ANNOTATION_FIELD_RE = re.compile(r"<moose:(x|y|width|height|bgColor)>([^<]*)</moose:\1>")
_GROUP_META_RE = re.compile(
    r"<moose:Group>([^<]*)</moose:Group>|<moose:Compartment>([^<]*)</moose:Compartment>"
)
_ENZYME_REF_RE = re.compile(r"<moose:enzyme>([^<]*)</moose:enzyme>")

_SPECIES_BLOCK_RE = re.compile(r"<species\b[^>]*>.*?</species>", re.DOTALL)
_REACTION_BLOCK_RE = re.compile(r"<reaction\b[^>]*>.*?</reaction>", re.DOTALL)
_ID_ATTR_RE = re.compile(r'\bid="([^"]+)"')
_XCORD_RE = re.compile(r"(<moose:xCord>)[^<]*(</moose:xCord>)")
_YCORD_RE = re.compile(r"(<moose:yCord>)[^<]*(</moose:yCord>)")


class _SbmlNamePaths:
    """Reconstructs the same (compartment, ...group names..., own name)
    tuple moose_graph.name_path computes on the live model, but purely from
    what a plain SBML file (as MOOSE writes it) can express -- so a written
    or reloaded element can be matched back to its live counterpart without
    relying on MOOSE's own idValue, which is session-ephemeral (see
    name_path's docstring: even reloading the same file twice gives
    different idValues, since it's a global, ever-incrementing counter, not
    one scoped to a single model). Built once per save/load and reused for
    every lookup during it."""

    def __init__(self, model):
        self._model = model
        self._compartment_name = {
            c.getId(): (c.getName() or c.getId()) for c in model.getListOfCompartments()
        }
        self._group_name = {}
        self._group_name_to_id = {}
        self._group_parent_name = {}
        self._group_compartment_id = {}
        self._member_group = {}
        plugin = model.getPlugin("groups")
        if plugin is not None:
            for i in range(plugin.getNumGroups()):
                grp = plugin.getGroup(i)
                gid = grp.getId()
                name = grp.getName() or gid
                self._group_name[gid] = name
                self._group_name_to_id[name] = gid
                parent_name = None
                compt_id = None
                for m in _GROUP_META_RE.finditer(grp.getAnnotationString() or ""):
                    if m.group(1) is not None:
                        parent_name = m.group(1)
                    elif m.group(2) is not None:
                        compt_id = m.group(2)
                self._group_parent_name[gid] = parent_name
                self._group_compartment_id[gid] = compt_id
                for member in grp.getListOfMembers():
                    self._member_group[member.getIdRef()] = gid

    def group_path(self, group_id):
        name = self._group_name.get(group_id)
        if name is None:
            return None
        parent_name = self._group_parent_name.get(group_id)
        if parent_name:
            parent_id = self._group_name_to_id.get(parent_name)
            parent_path = self.group_path(parent_id) if parent_id else None
            if parent_path is not None:
                return parent_path + (name,)
            return (parent_name, name)
        compt_id = self._group_compartment_id.get(group_id)
        return (self._compartment_name.get(compt_id, compt_id), name)

    def _species_name(self, species_id):
        sp = self._model.getSpecies(species_id)
        return (sp.getName() or sp.getId()) if sp else species_id

    def species_path(self, species_id):
        group_id = self._member_group.get(species_id)
        if group_id is not None:
            group_path = self.group_path(group_id)
            if group_path is not None:
                return group_path + (self._species_name(species_id),)
        sp = self._model.getSpecies(species_id)
        compt_name = self._compartment_name.get(sp.getCompartment()) if sp else None
        return (compt_name, self._species_name(species_id))

    def reaction_path(self, reaction):
        """`reaction` is a libsbml Reaction object -- covers both a plain
        kinetic reaction and one stage of an EnzymaticReaction, which SBML
        can only place via its parent pool's species id (it has no
        container of its own in kkit, same as a plain reaction). An
        explicit-complex enzyme's stage(s) carry a moose:enzyme annotation
        naming that pool directly; a Michaelis-Menten enzyme carries no
        such tag at all (verified directly) -- its catalyzing pool is
        instead the reaction's sole SBML modifier species."""
        name = reaction.getName() or reaction.getId()
        enz_match = _ENZYME_REF_RE.search(reaction.getAnnotationString() or "")
        if enz_match:
            return self.species_path(enz_match.group(1)) + (name,)
        modifiers = reaction.getListOfModifiers()
        if modifiers.size() == 1:
            return self.species_path(modifiers.get(0).getSpecies()) + (name,)

        participant_ids = [
            ref_list.get(j).getSpecies()
            for ref_list in (reaction.getListOfReactants(), reaction.getListOfProducts())
            for j in range(ref_list.size())
        ]
        group_id = self._member_group.get(reaction.getId())
        if group_id is None:
            # moose's writer doesn't reliably list a plain reaction as a
            # group member even when it structurally belongs to one
            # (verified directly against group_epi.g: its pools are listed,
            # its own "inhib" reaction is not) -- inferred here from
            # whichever group its own participant species belong to
            # instead, since a reaction and its substrate/product pools are
            # always grouped together in kkit.
            for sid in participant_ids:
                group_id = self._member_group.get(sid)
                if group_id is not None:
                    break
        if group_id is not None:
            group_path = self.group_path(group_id)
            if group_path is not None:
                return group_path + (name,)

        # Ungrouped (or unresolved), and a plain <reaction> carries no
        # compartment attribute of its own in SBML -- inferred from a
        # participant species instead (safe given this app doesn't support
        # cross-compartment reactions).
        if participant_ids:
            sp = self._model.getSpecies(participant_ids[0])
            compt_name = self._compartment_name.get(sp.getCompartment()) if sp else None
            return (compt_name, name)
        return (None, name)


def _snapshot_positions(model_path):
    """moose.writeSBML has a confirmed side effect: for any pool, reaction,
    or enzyme that's (or, for an enzyme, whose parent pool is) a member of
    an SBML group, it silently overwrites that element's *live* /info x/y
    with an internally auto-computed layout position while producing the
    file -- verified directly for all three kinds (a plain top-level
    pool/reac's position survives a save untouched; the identical one
    nested in a group gets its live Annotator corrupted by the save itself,
    before the file is even looked at again). Snapshotting beforehand,
    keyed by name_path rather than MOOSE's own idValue (session-ephemeral --
    see that function's docstring), is what lets save_sbml both restore the
    live model afterward (so just clicking Save doesn't scramble the
    running session) and patch the written XML with the true values (see
    _fix_positions_in_sbml)."""
    snapshot = {}
    for isa in ("PoolBase", "Reac", "EnzBase", "ConcChan"):
        for e in moose.wildcardFind(f"{model_path}/##[ISA={isa}]"):
            e = moose.element(e)
            if moose.exists(e.path + "/info"):
                info = moose.element(e.path + "/info")
                snapshot[name_path(e.path, model_path)] = (e.path, info.x, info.y)
    return snapshot


def _restore_positions(snapshot):
    for path, x, y in snapshot.values():
        info = moose.element(path + "/info")
        info.x = x
        info.y = y


def _fix_positions_in_sbml(content, snapshot):
    """Patches the xCord/yCord baked into the SBML text for every species
    and reaction (the latter also covering each stage of an
    EnzymaticReaction) using the pre-write snapshot (see
    _snapshot_positions), since moose.writeSBML writes the very same
    auto-computed value into the file that it corrupts the live model
    with."""
    doc = libsbml.readSBMLFromString(content)
    model = doc.getModel()
    if model is None:
        return content
    paths = _SbmlNamePaths(model)

    def _patch(block, key):
        if key not in snapshot:
            return block
        _, x, y = snapshot[key]
        block = _XCORD_RE.sub(rf"\g<1>{x}\g<2>", block, count=1)
        block = _YCORD_RE.sub(rf"\g<1>{y}\g<2>", block, count=1)
        return block

    def _replace_species(m):
        sid_match = _ID_ATTR_RE.search(m.group(0))
        if not sid_match:
            return m.group(0)
        return _patch(m.group(0), paths.species_path(sid_match.group(1)))

    content = _SPECIES_BLOCK_RE.sub(_replace_species, content)

    def _replace_reaction(m):
        rid_match = _ID_ATTR_RE.search(m.group(0))
        reaction = model.getReaction(rid_match.group(1)) if rid_match else None
        if reaction is None:
            return m.group(0)
        return _patch(m.group(0), paths.reaction_path(reaction))

    return _REACTION_BLOCK_RE.sub(_replace_reaction, content)


_LIST_OF_MEMBERS_CLOSE_RE = re.compile(r"</groups:listOfMembers>")


def _fix_missing_reaction_group_memberships(content):
    """moose.writeSBML doesn't reliably list a plain reaction as a member
    of the group it structurally belongs to (verified directly against
    group_epi.g: its pools are listed as members, its own "inhib" reaction
    is not). Without that membership, moose.readSBML has no way to know the
    reaction belongs there and places it at the model's top level on
    reload instead -- a real structural loss, not just a missing display
    position. This adds the missing membership before the file is ever
    reloaded, inferred the same way _SbmlNamePaths.reaction_path already
    does: from whichever group the reaction's own participant species
    belong to."""
    doc = libsbml.readSBMLFromString(content)
    model = doc.getModel()
    if model is None:
        return content
    plugin = model.getPlugin("groups")
    if plugin is None:
        return content
    paths = _SbmlNamePaths(model)

    to_add = {}
    for i in range(model.getNumReactions()):
        r = model.getReaction(i)
        rid = r.getId()
        if rid in paths._member_group:
            continue
        # Enzyme stages are placed via their pool (moose:enzyme tag, or the
        # sole modifier for a Michaelis-Menten stage), not group
        # membership -- nothing to add for those.
        if _ENZYME_REF_RE.search(r.getAnnotationString() or ""):
            continue
        if r.getListOfModifiers().size() == 1:
            continue
        participant_ids = [
            ref_list.get(j).getSpecies()
            for ref_list in (r.getListOfReactants(), r.getListOfProducts())
            for j in range(ref_list.size())
        ]
        group_id = next((paths._member_group.get(sid) for sid in participant_ids
                          if paths._member_group.get(sid) is not None), None)
        if group_id is not None:
            to_add.setdefault(group_id, []).append(rid)

    if not to_add:
        return content

    def _replace_group(m):
        block = m.group(0)
        id_match = _GROUPS_ID_ATTR_RE.search(block)
        rids = to_add.get(id_match.group(1)) if id_match else None
        if not rids:
            return block
        insertion = "".join(f'<groups:member groups:idRef="{rid}"/>' for rid in rids)
        return _LIST_OF_MEMBERS_CLOSE_RE.sub(insertion + "</groups:listOfMembers>", block, count=1)

    return _GROUP_BLOCK_RE.sub(_replace_group, content)


_KKIT_NS = "http://www.moose.ncbs.res.in/kkit-web"
_PLOT_WINDOW_TAG_RE = re.compile(r"<kkit:plotWindow[^>]*>(\d+)</kkit:plotWindow>")


def _inject_plot_annotations(content, model_path, plots):
    """`plots` ({live pool path: window}, from the frontend's own
    plotWindow -- see App.jsx) has no native SBML representation to ride
    along in (confirmed directly: moose.writeSBML never serializes the
    legacy .g format's own /graphs plot tables at all), so this adds a
    small custom-namespaced annotation to each plotted species -- the
    standard SBML mechanism for vendor-specific extensions, which any
    other SBML-aware tool simply ignores rather than chokes on."""
    if not plots:
        return content
    doc = libsbml.readSBMLFromString(content)
    model = doc.getModel()
    if model is None:
        return content
    paths = _SbmlNamePaths(model)

    name_path_to_species_id = {
        paths.species_path(sp.getId()): sp.getId() for sp in model.getListOfSpecies()
    }
    window_by_species_id = {}
    for pool_path, window in plots.items():
        sid = name_path_to_species_id.get(name_path(pool_path, model_path))
        if sid is not None:
            window_by_species_id[sid] = window
    if not window_by_species_id:
        return content

    def _replace(m):
        sid_match = _ID_ATTR_RE.search(m.group(0))
        if not sid_match or sid_match.group(1) not in window_by_species_id:
            return m.group(0)
        window = window_by_species_id[sid_match.group(1)]
        tag = f'<kkit:plotWindow xmlns:kkit="{_KKIT_NS}">{window}</kkit:plotWindow>'
        block = m.group(0)
        if "</annotation>" in block:
            return block.replace("</annotation>", tag + "</annotation>", 1)
        return block.replace("</species>", f"<annotation>{tag}</annotation></species>", 1)

    return _SPECIES_BLOCK_RE.sub(_replace, content)


def _extract_plot_windows(content, model_path):
    """Reads back the kkit:plotWindow annotation this app writes on save
    (see _inject_plot_annotations), resolved to the freshly-reloaded live
    pool paths via name_path -- for build_graph's extra_plot_windows."""
    doc = libsbml.readSBMLFromString(content)
    model = doc.getModel()
    if model is None:
        return {}
    paths = _SbmlNamePaths(model)

    windows_by_name_path = {}
    for sp in model.getListOfSpecies():
        m = _PLOT_WINDOW_TAG_RE.search(sp.getAnnotationString() or "")
        if m:
            windows_by_name_path[paths.species_path(sp.getId())] = int(m.group(1))
    if not windows_by_name_path:
        return {}

    result = {}
    for p in moose.wildcardFind(model_path + "/##[ISA=PoolBase]"):
        p = moose.element(p)
        window = windows_by_name_path.get(name_path(p.path, model_path))
        if window is not None:
            result[p.path] = window
    return result


_KKIT_COLLAPSED_TAG_RE = re.compile(r"<kkit:collapsed[^>]*>(true|false)</kkit:collapsed>")


def _inject_collapsed_annotations(content, model_path, collapsed):
    """`collapsed` ({live group/compartment path: bool}, from the
    frontend's own per-group collapse toggle -- see App.jsx) has no native
    SBML representation, same reasoning as _inject_plot_annotations -- a
    small custom-namespaced annotation directly on each group's own SBML
    "groups"-package element, or a compartment's native <compartment>
    element (groups and compartments are treated identically for this
    feature). Uses libsbml's own appendAnnotation (merges into whatever
    annotation is already there rather than clobbering it) instead of the
    regex text-splicing the position-fixing functions above need -- there's
    no existing moose.writeSBML bug to work around here, so the plain
    object API is enough."""
    if not collapsed:
        return content
    doc = libsbml.readSBMLFromString(content)
    model = doc.getModel()
    if model is None:
        return content
    paths = _SbmlNamePaths(model)
    # Keyed by live path (like every other per-node map the frontend sends,
    # e.g. plots) -- converted once to the same name_path tuples the SBML
    # side's own group_path/_compartment_name resolve to, matching
    # _inject_plot_annotations' own name_path_to_species_id approach.
    collapsed_by_name_path = {
        name_path(live_path, model_path): value for live_path, value in collapsed.items()
    }

    def _tag(value):
        return f'<kkit:collapsed xmlns:kkit="{_KKIT_NS}">{"true" if value else "false"}</kkit:collapsed>'

    changed = False
    plugin = model.getPlugin("groups")
    if plugin is not None:
        for i in range(plugin.getNumGroups()):
            grp = plugin.getGroup(i)
            value = collapsed_by_name_path.get(paths.group_path(grp.getId()))
            if value is not None:
                grp.appendAnnotation(_tag(value))
                changed = True
    for compt in model.getListOfCompartments():
        value = collapsed_by_name_path.get((paths._compartment_name.get(compt.getId(), compt.getId()),))
        if value is not None:
            compt.appendAnnotation(_tag(value))
            changed = True
    return libsbml.writeSBMLToString(doc) if changed else content


def _extract_collapsed(content, model_path):
    """Reads back the kkit:collapsed annotation this app writes on save
    (see _inject_collapsed_annotations), resolved to the freshly-reloaded
    live group/compartment paths via name_path -- for build_graph's
    extra_collapsed."""
    doc = libsbml.readSBMLFromString(content)
    model = doc.getModel()
    if model is None:
        return {}
    paths = _SbmlNamePaths(model)

    by_name_path = {}
    plugin = model.getPlugin("groups")
    if plugin is not None:
        for i in range(plugin.getNumGroups()):
            grp = plugin.getGroup(i)
            m = _KKIT_COLLAPSED_TAG_RE.search(grp.getAnnotationString() or "")
            if m:
                by_name_path[paths.group_path(grp.getId())] = m.group(1) == "true"
    for compt in model.getListOfCompartments():
        m = _KKIT_COLLAPSED_TAG_RE.search(compt.getAnnotationString() or "")
        if m:
            by_name_path[(paths._compartment_name.get(compt.getId(), compt.getId()),)] = m.group(1) == "true"
    if not by_name_path:
        return {}

    result = {}
    for g in moose.wildcardFind(model_path + "/##[CLASS=Neutral]"):
        g = moose.element(g)
        val = by_name_path.get(name_path(g.path, model_path))
        if val is not None:
            result[g.path] = val
    for c in moose.wildcardFind(model_path + "/##[CLASS=CubeMesh]"):
        c = moose.element(c)
        val = by_name_path.get(name_path(c.path, model_path))
        if val is not None:
            result[c.path] = val
    return result


_KKIT_STIM_TAG_RE = re.compile(
    r'<kkit:stimulus[^>]*\bname="([^"]*)"[^>]*\bfield="([^"]*)"'
    r'(?:[^>]*\bkind="([^"]*)")?'
    r'(?:[^>]*\bnumInputs="([^"]*)")?'
    r'(?:[^>]*\binputs="([^"]*)")?'
    r'[^>]*\bx="([^"]*)"[^>]*\by="([^"]*)"[^>]*>'
    r"(.*?)</kkit:stimulus>",
    re.DOTALL,
)
_RULE_BLOCK_RE = re.compile(r"<listOfRules>.*?</listOfRules>", re.DOTALL)


def _snapshot_stims(model_path):
    """Function-based Stimulus/summation/general-function objects:
    moose.writeSBML doesn't represent them faithfully at all -- verified
    directly, it flattens the valueOut connection into an *invalid* SBML
    assignmentRule referencing the bare identifier 't' (not a valid
    reference to any species/compartment/parameter/reaction, so any
    strict SBML consumer rejects it), and the Function object's own
    identity, expr, pool-input wiring and position are all lost from the
    file entirely. Persisted instead via a custom annotation on the target
    species (see _inject_stim_annotations), the same approach already used
    for plot windows -- snapshotting here (rather than reading back
    anything from the written file) since nothing about one of these
    survives the write in a usable form to read back from.

    `kind`/`inputs`/`numInputs` are what let a summation or general
    function's own pool-input wiring (never captured here before -- see
    the bug this was written to fix: reloading such a model silently lost
    every funcInput connection, and a summation function's own
    allowUnknownVariable=False -- the ONLY thing describe_stim's own
    classifier uses to tell it apart from a general function, see its own
    docstring -- was never persisted either, so it silently came back as
    a general function instead) survive a save/reload round trip too."""
    stims = []
    for f in moose.wildcardFind(f"{model_path}/##[ISA=Function]"):
        f = moose.element(f)
        target_path, dest_field = _stim_field(f)
        if not target_path or not dest_field:
            continue
        info = moose.element(f.path + "/info") if moose.exists(f.path + "/info") else None
        kind = "sum" if not f.allowUnknownVariable else "general" if f.numVars > 0 else "stim"
        stims.append({
            "name": f.name,
            "expr": clean_func_expr(f),
            "field": dest_field[3].lower() + dest_field[4:],
            "target_path": target_path,
            "x": info.x if info else 0.0,
            "y": info.y if info else 0.0,
            "kind": kind,
            "num_inputs": f.numVars,
            "inputs": _function_inputs(f),
        })
    return stims


def _inject_stim_annotations(content, model_path, stims):
    if not stims:
        return content
    # moose.writeSBML's Function->assignmentRule serialization is broken in
    # more than one way: it references the bare identifier 't' (not a
    # valid SBML variable reference at all), and -- verified directly, when
    # the target pool is a group member -- sometimes references the
    # *group's* own id instead of the pool's species id, an outright wrong
    # target rather than just an invalid one. Since this app never writes
    # a genuine SBML rule any other way, every <listOfRules> entry in a
    # file it produces exists only as this same broken byproduct -- so the
    # whole block is dropped unconditionally (rather than trying to
    # surgically match rules to targets by variable id, which the second
    # bug defeats) before our own replacement annotation goes in.
    content = _RULE_BLOCK_RE.sub("", content)
    doc = libsbml.readSBMLFromString(content)
    model = doc.getModel()
    if model is None:
        return content
    paths = _SbmlNamePaths(model)
    name_path_to_species_id = {
        paths.species_path(sp.getId()): sp.getId() for sp in model.getListOfSpecies()
    }

    by_species_id = {}
    for stim in stims:
        sid = name_path_to_species_id.get(name_path(stim["target_path"], model_path))
        if sid is not None:
            by_species_id.setdefault(sid, []).append(stim)
    if not by_species_id:
        return content

    def _replace(m):
        sid_match = _ID_ATTR_RE.search(m.group(0))
        if not sid_match or sid_match.group(1) not in by_species_id:
            return m.group(0)
        block = m.group(0)
        tags = "".join(
            f'<kkit:stimulus xmlns:kkit="{_KKIT_NS}" name="{html.escape(s["name"])}" '
            f'field="{s["field"]}" kind="{s["kind"]}" numInputs="{s["num_inputs"]}" '
            # Each input pool is written as its own name-path (the same
            # stable, session-independent identifier the target itself is
            # matched by -- see name_path's own docstring), "/"-joined
            # since a plain name can't itself contain "/"; several inputs
            # are ";"-joined, in x0/x1/... order -- _restore_stims reverses
            # both splits the same way, against the SAME live_by_path map
            # it already builds for the target.
            f'inputs="{html.escape(";".join("/".join(name_path(p, model_path)) for p in s["inputs"]))}" '
            f'x="{s["x"]}" y="{s["y"]}">'
            f'{html.escape(s["expr"])}</kkit:stimulus>'
            for s in by_species_id[sid_match.group(1)]
        )
        if "</annotation>" in block:
            return block.replace("</annotation>", tags + "</annotation>", 1)
        return block.replace("</species>", f"<annotation>{tags}</annotation></species>", 1)

    return _SPECIES_BLOCK_RE.sub(_replace, content)


def _restore_stims(doc, model_path):
    """Rebuilds each Stimulus/summation/general-function's actual
    moose.Function object (expr, target connection, pool-input wiring,
    kind, position) from the custom annotation this app writes on save
    (see _inject_stim_annotations) -- moose's own writeSBML+readSBML
    round-trip loses one of these entirely (see _snapshot_stims's own
    docstring), so this is the only path that recreates it at all,
    mirroring how _restore_group_annotations recreates group boxes after
    the fact."""
    model = doc.getModel()
    if model is None:
        return
    paths = _SbmlNamePaths(model)
    live_by_path = {}
    for p in moose.wildcardFind(model_path + "/##[ISA=PoolBase]"):
        p = moose.element(p)
        live_by_path[name_path(p.path, model_path)] = p.path

    for sp in model.getListOfSpecies():
        target_path = live_by_path.get(paths.species_path(sp.getId()))
        if target_path is None:
            continue
        for m in _KKIT_STIM_TAG_RE.finditer(sp.getAnnotationString() or ""):
            name, field, kind, num_inputs_str, inputs_str, x, y, expr = m.groups()
            target = moose.element(target_path)
            container = target.path
            stim_name = _unique_name(container, name or "stim")
            func = moose.Function(f"{container}/{stim_name}")
            func.doEvalAtReinit = True
            if kind == "sum":
                func.allowUnknownVariable = False
            # Reconnect every input pool, in its own original x0/x1/...
            # order, resolved via the SAME live_by_path name-path map the
            # target itself was just matched through -- see add_edge's
            # own func.x[i] comment for why a bare, non-field-indexed
            # element reference here would silently misconnect everything
            # past the first input.
            slot = 0
            for name_path_str in (inputs_str or "").split(";"):
                if not name_path_str:
                    continue
                input_path = live_by_path.get(tuple(name_path_str.split("/")))
                if input_path is None:
                    continue
                func.numVars = slot + 1
                moose.connect(moose.element(input_path), "nOut", func.x[slot], "input")
                slot += 1
            # A general function's own declared capacity can exceed how
            # many inputs actually got reconnected (a reserved,
            # not-yet-wired slot -- see update_stim's own numInputs
            # handling); never shrunk below what was just wired.
            if num_inputs_str:
                try:
                    func.numVars = max(func.numVars, int(num_inputs_str))
                except ValueError:
                    pass
            dest_field = "set" + field[0].upper() + field[1:] if field else "setConc"
            moose.connect(func, "valueOut", target, dest_field)
            set_func_expr(func, html.unescape(expr))
            create_info(func.path, float(x), float(y), color="red")


_GROUP_BLOCK_RE = re.compile(r"<groups:group\b.*?</groups:group>", re.DOTALL)
_GROUPS_ID_ATTR_RE = re.compile(r'groups:id="([^"]+)"')
_GROUP_ANN_OPEN_RE = re.compile(r"(<moose:GroupAnnotation>)")
_STALE_LAYOUT_FIELD_RE = re.compile(r"<moose:(x|y|width|height|bgColor)>[^<]*</moose:\1>\s*")


def _snapshot_group_boxes(model_path):
    """Companion to _snapshot_positions, for groups: moose.writeSBML has a
    second, distinct bug here -- rather than writing a wrong auto-computed
    value like it does for a grouped pool/reac/enz, it omits a group's
    x/y/width/height annotation *entirely* whenever its live width is 0
    (verified directly), which is true for every group that's never been
    explicitly resized -- the common case for a freshly-loaded legacy .g
    file. Snapshotting each group's full box (plus color) beforehand is
    what lets _fix_group_positions_in_sbml regenerate it unconditionally."""
    snapshot = {}
    for g in moose.wildcardFind(f"{model_path}/##[CLASS=Neutral]"):
        g = moose.element(g)
        if moose.exists(g.path + "/info"):
            info = moose.element(g.path + "/info")
            snapshot[name_path(g.path, model_path)] = (
                info.x, info.y, info.width, info.height, info.color
            )
    return snapshot


def _fix_group_positions_in_sbml(content, snapshot):
    """Regenerates each group's x/y/width/height/bgColor annotation fields
    from the pre-write snapshot (see _snapshot_group_boxes) unconditionally
    -- rather than patch-if-present, since the writer may have omitted them
    entirely -- dropping whatever (possibly absent, possibly present) ones
    it actually produced."""
    doc = libsbml.readSBMLFromString(content)
    model = doc.getModel()
    if model is None:
        return content
    paths = _SbmlNamePaths(model)

    def _replace(m):
        block = m.group(0)
        id_match = _GROUPS_ID_ATTR_RE.search(block)
        if not id_match:
            return block
        key = paths.group_path(id_match.group(1))
        if key not in snapshot:
            return block
        x, y, width, height, color = snapshot[key]
        fresh = (
            f"<moose:x>{x}</moose:x><moose:y>{y}</moose:y>"
            f"<moose:width>{width}</moose:width><moose:height>{height}</moose:height>"
            f"<moose:bgColor>{color}</moose:bgColor>"
        )
        block = _STALE_LAYOUT_FIELD_RE.sub("", block)
        return _GROUP_ANN_OPEN_RE.sub(r"\1" + fresh.replace("\\", "\\\\"), block, count=1)

    return _GROUP_BLOCK_RE.sub(_replace, content)


def _restore_group_annotations(doc, model_path):
    """moose.writeSBML already emits a full, native SBML "groups" package
    entry for each kkit Group -- structure and membership round-trip on
    their own via moose.readSBML -- but its position/size/color (carried in
    a custom moose:GroupAnnotation on that same group element, verified
    directly by writing then reloading one) isn't recreated as an /info
    Annotator on read. This re-derives that Annotator from the SBML text
    itself after the structural reload, matching each SBML group to the
    reloaded moose Neutral by name_path (not bare name -- two groups with
    the same name in different compartments/parents, while unusual, would
    otherwise collide; name_path disambiguates them exactly like it does
    for positions -- see _snapshot_positions)."""
    model = doc.getModel()
    if model is None:
        return
    plugin = model.getPlugin("groups")
    if plugin is None:
        return
    paths = _SbmlNamePaths(model)

    live_by_path = {}
    for g in moose.wildcardFind(model_path + "/##[CLASS=Neutral]"):
        g = moose.element(g)
        live_by_path[name_path(g.path, model_path)] = g.path

    for i in range(plugin.getNumGroups()):
        grp = plugin.getGroup(i)
        fields = dict(_GROUP_ANNOTATION_FIELD_RE.findall(grp.getAnnotationString() or ""))
        if not fields:
            continue
        live_path = live_by_path.get(paths.group_path(grp.getId()))
        if live_path is None:
            continue
        create_info(
            live_path,
            float(fields.get("x", 0)),
            float(fields.get("y", 0)),
            color=fields.get("bgColor", "white"),
            width=float(fields.get("width", 0)),
            height=float(fields.get("height", 0)),
        )


_LIST_OF_REACTIONS_OPEN_RE = re.compile(r"<listOfReactions\b[^>]*>")
_LIST_OF_REACTIONS_SELFCLOSE_RE = re.compile(r"<listOfReactions\s*/>")
_DUMMY_REAC_ID = "__kkitweb_dummy_reac"
_DUMMY_REAC_XML_TEMPLATE = (
    f'<reaction id="{_DUMMY_REAC_ID}" reversible="false" fast="false">'
    '<listOfReactants><speciesReference species="{sid}" stoichiometry="1" constant="false"/></listOfReactants>'
    '<listOfProducts><speciesReference species="{sid}" stoichiometry="1" constant="false"/></listOfProducts>'
    '<kineticLaw><math xmlns="http://www.w3.org/1998/Math/MathML"><cn>0</cn></math></kineticLaw>'
    "</reaction>"
)


def _has_real_reaction(model):
    """True if the model has at least one <reaction> that moose.readSBML
    will actually turn into a Reac or EnzBase object -- a ConcChan is also
    written as a plain SBML <reaction> (tagged moose:Channel, see
    moose_graph.name_path's docstring) but becomes a moose.ConcChan on
    reload instead, so it does NOT count toward the ISA=Reac/EnzBase check
    _ensure_reaction_present is working around; model.getNumReactions()
    alone can't tell the two apart."""
    for i in range(model.getNumReactions()):
        if "<moose:Channel>" not in (model.getReaction(i).getAnnotationString() or ""):
            return True
    return False


def _ensure_reaction_present(content, model):
    """moose.readSBML has a confirmed bug (verified directly): if the file
    it's reading produces zero Reac/EnzBase objects -- true for *any*
    reaction-free model, not just a ConcChan/Stimulus-only one, even a
    single bare pool with no reactions at all -- it silently deletes the
    ENTIRE freshly-loaded model and reports a generic "Atleast one
    reaction should be present to display in the widget" message instead
    of the real structural content. A harmless zero-rate self-reaction on
    the file's own first species (reused, not a synthetic one -- SBML
    allows the same species as both reactant and product) is injected here
    before moose ever sees the file, whenever it has no such reaction of
    its own -- stripped back out of the reloaded live model immediately
    after (see _strip_dummy_reaction) -- invisible both for round-trips
    through this app's own save and for a genuinely reaction-free foreign
    file."""
    if model is None or _has_real_reaction(model):
        return content
    species = model.getListOfSpecies()
    if species.size() == 0:
        return content
    dummy = _DUMMY_REAC_XML_TEMPLATE.format(sid=species.get(0).getId())
    if _LIST_OF_REACTIONS_SELFCLOSE_RE.search(content):
        return _LIST_OF_REACTIONS_SELFCLOSE_RE.sub(f"<listOfReactions>{dummy}</listOfReactions>", content, count=1)
    if _LIST_OF_REACTIONS_OPEN_RE.search(content):
        return _LIST_OF_REACTIONS_OPEN_RE.sub(lambda m: m.group(0) + dummy, content, count=1)
    return content.replace("</model>", f"<listOfReactions>{dummy}</listOfReactions></model>", 1)


def _strip_dummy_reaction(model_path):
    for e in moose.wildcardFind(f"{model_path}/##[ISA=Reac]"):
        e = moose.element(e)
        if e.name.startswith(_DUMMY_REAC_ID):
            moose.delete(e.path)


def _unwrap_notes(notes_xml):
    if not notes_xml:
        return ""
    m = _NOTES_BODY_RE.search(notes_xml)
    if not m:
        return ""
    return html.unescape(m.group(1).replace("<br/>", "\n"))

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


@app.post("/api/new_model")
def new_model():
    """Starts a fresh, empty model -- just the default 'kinetics'
    compartment, no pools/reactions -- rather than pre-loading any example
    file. Used for the app's own initial load (see App.jsx) and for
    File > New window."""
    model_path = _new_model_path()
    moose.Neutral(model_path)
    c = moose.CubeMesh(f"{model_path}/kinetics")
    c.volume = 1.6667e-21
    create_info(c.path, 0.0, 0.0, width=8.0, height=6.0)
    return jsonify(build_graph(model_path))


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


@app.post("/api/upload_gfile")
def upload_gfile():
    """Load a legacy kkit .g file from raw text content (the file-picker
    upload path), mirroring /api/load_sbml's temp-file pattern -- moose.loadModel
    needs an actual filesystem path, so the uploaded content is staged to one."""
    content = request.json.get("content")
    if not content:
        return jsonify({"error": "no file content provided"}), 400
    fd, path = tempfile.mkstemp(suffix=".g")
    with os.fdopen(fd, "w") as f:
        f.write(content)
    model_path = _new_model_path()
    moose.loadModel(path, model_path, "ee")
    os.remove(path)
    result = build_graph(model_path)
    result["notes"] = _extract_g_model_notes(content)
    return jsonify(result)


@app.get("/api/graph")
def get_graph():
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    return jsonify(build_graph(_current_model_path))


def _update_node(node_id, fields, numeric_fields, bool_fields, describe_fn, string_fields=()):
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

    # An explicit-complex Enz's k1 is subordinate to Km (see Enz.cpp's own
    # field doc for k1): setting k2 or k3 holds Km fixed and recomputes
    # k1 to match, so k1 must be applied *last* when several of an
    # enzyme's rate fields are edited together -- a stable sort moving
    # only "k1" to the end leaves every other field's relative order
    # untouched.
    for key, value in sorted(fields.items(), key=lambda kv: kv[0] == "k1"):
        if key in numeric_fields:
            setattr(elem, key, float(value))
        elif key in bool_fields:
            setattr(elem, key, bool(value))
        elif key in string_fields:
            setattr(elem, key, value)
        elif key == "color":
            info.color = normalize_color(value)
        elif key == "notes":
            info.notes = value

    result = describe_fn(elem.path)
    result["previousId"] = node_id
    return jsonify(result)


_POOL_SIM_FIELDS = {"n", "nInit", "conc", "concInit", "diffConst", "motorConst"}


@app.post("/api/update_pool")
def update_pool():
    body = request.json or {}
    # conc/concInit are shown and edited in uM (see describe_pool) but
    # stored in MOOSE natively as mM -- convert back at the one place a
    # user's edit actually reaches the live model.
    fields = dict(body.get("fields", {}))
    for key in ("conc", "concInit"):
        if key in fields:
            fields[key] = float(fields[key]) / 1000.0
    return _update_node(body.get("id"), fields, _POOL_SIM_FIELDS, {"isBuffered"}, describe_pool)


_REAC_SIM_FIELDS = {"Kf", "Kb", "numKf", "numKb"}


@app.post("/api/update_reac")
def update_reac():
    body = request.json or {}
    node_id = body.get("id")
    if _current_model_path is None or not node_id or not node_id.startswith(_current_model_path):
        return jsonify({"error": "invalid or stale node id"}), 400
    if not moose.exists(node_id):
        return jsonify({"error": f"node not found: {node_id}"}), 404

    # Kf/Kb are shown and edited in uM (order-scaled, see describe_reac's
    # _conc_scale) but stored in MOOSE natively as mM -- convert back
    # using this same reaction's own order, computed before any of the
    # requested fields are actually applied. Kf/Kb carry a *negative*
    # power of concentration (see _conc_scale), so going display -> raw
    # multiplies by the scale factor -- the inverse of describe_reac's own
    # raw -> display division.
    fields = dict(body.get("fields", {}))
    sub_order, prd_order = _reac_orders(moose.element(node_id))
    if "Kf" in fields:
        fields["Kf"] = float(fields["Kf"]) * _conc_scale(sub_order)
    if "Kb" in fields:
        fields["Kb"] = float(fields["Kb"]) * _conc_scale(prd_order)
    return _update_node(node_id, fields, _REAC_SIM_FIELDS, set(), describe_reac)


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
    fields = dict(body.get("fields", {}))
    # Km (michaelis-menten only -- explicit-complex's own Km is a derived
    # read-only field, never in the editable set) is shown/edited in uM
    # but stored natively as mM.
    if mechanism == "michaelis-menten" and "Km" in fields:
        fields["Km"] = float(fields["Km"]) / 1000.0
    return _update_node(node_id, fields, _ENZ_SIM_FIELDS[mechanism], set(), describe_enz)


@app.post("/api/update_group")
def update_group():
    body = request.json or {}
    return _update_node(body.get("id"), body.get("fields", {}), set(), set(), describe_group)


@app.post("/api/update_compartment")
def update_compartment():
    body = request.json or {}
    node_id = body.get("id")
    fields = dict(body.get("fields", {}))
    if _current_model_path is None or not node_id or not node_id.startswith(_current_model_path):
        return jsonify({"error": "invalid or stale node id"}), 400
    if not moose.exists(node_id):
        return jsonify({"error": f"node not found: {node_id}"}), 404

    # diameter is a derived, invertible convenience (see
    # moose_graph.diameter_to_volume), not a real CubeMesh field -- when
    # present it always wins over a same-request "volume" (which the
    # frontend sends alongside it unconditionally, per its usual
    # send-every-field-in-the-row pattern, but would otherwise still hold
    # its pre-edit, now-stale value).
    if "diameter" in fields:
        moose.element(node_id).volume = diameter_to_volume(float(fields.pop("diameter")))
        fields.pop("volume", None)
    return _update_node(node_id, fields, {"volume"}, set(), describe_compartment)


@app.post("/api/update_position")
def update_position():
    body = request.json or {}
    node_id = body.get("id")
    if _current_model_path is None or not node_id or not node_id.startswith(_current_model_path):
        return jsonify({"error": "invalid or stale node id"}), 400
    if not moose.exists(node_id):
        return jsonify({"error": f"node not found: {node_id}"}), 404

    # A shift-drag out of its current group/compartment (see MainDisplay's
    # own onNodeDragStop) -- moose.move keeps every existing message/
    # structural-child connection intact (verified directly), unlike a
    # delete+recreate would. The node's own id (a live moose path) changes
    # as a result, and so does every descendant's -- reported back as "id"
    # so the frontend knows to do a full graph refetch rather than trying
    # to patch just this one node's stale id in place (same reasoning as
    # _update_node's own "previousId", just for however many ids moved this
    # time instead of exactly one).
    new_parent_id = body.get("newParentId")
    if new_parent_id:
        if not new_parent_id.startswith(_current_model_path) or not moose.exists(new_parent_id):
            return jsonify({"error": f"new parent not found: {new_parent_id}"}), 404
        if moose.element(new_parent_id).className not in _CONTAINER_CLASSES:
            return jsonify({"error": "can only move something into a group or compartment"}), 400
        if is_enz_complex(node_id):
            return jsonify({"error": "an enzyme's complex pool can't be moved on its own"}), 400
        if moose.element(node_id).className == "CubeMesh":
            return jsonify({"error": "a compartment can't be moved into anything"}), 400
        elem = moose.element(node_id)
        new_parent = moose.element(new_parent_id)
        if elem.parent.path == new_parent.path:
            return jsonify({"error": "already in that group"}), 400
        name = _unique_name(new_parent_id, elem.name)
        if name != elem.name:
            elem.name = name
        moose.move(elem, new_parent)
        node_id = elem.path

    # /info is normally created alongside a node at the moment it first gets
    # *any* explicit position (create_info, called from every "add X"
    # endpoint) -- but the one compartment a brand-new/freshly-loaded model
    # starts with is never itself created that way, so it can reach here
    # with no /info yet (verified directly: moose_graph.py's own _info()
    # already tolerates this missing case for reads, defaulting to zeros --
    # this is the equivalent tolerance for the write side, rather than
    # 404ing on the first-ever attempt to position/resize it).
    if not moose.exists(node_id + "/info"):
        create_info(node_id, 0.0, 0.0)

    info = moose.element(node_id + "/info")
    info.x = float(body.get("x"))
    info.y = float(body.get("y"))
    result = {"ok": True, "x": info.x, "y": info.y, "id": node_id}
    # width/height are only ever sent when resizing a group/compartment box
    # (see nodes.jsx's NodeResizer) -- optional so plain pool/reac/enz drags
    # don't need to touch them.
    if "width" in body:
        info.width = float(body["width"])
        result["width"] = info.width
    if "height" in body:
        info.height = float(body["height"])
        result["height"] = info.height
    return jsonify(result)


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
    if is_enz_complex(from_id) or is_enz_complex(to_id):
        return jsonify({"error": "an enzyme's complex pool can't be connected to anything"}), 400

    # A substrate/product edge to an actual Reac (not an Enz -- Km/kcat
    # aren't order-scaled the way Kf/Kb are, see describe_enz) changes that
    # reaction's order, which silently reinterprets its raw Kf/Kb under new
    # units unless rescaled -- snapshot the order *before* connecting so
    # rescale_reac_for_order_change has something to hold fixed.
    reac_elem, old_sub_order, old_prd_order = None, None, None
    if edge_type in ("substrate", "product"):
        candidate = moose.element(to_id if edge_type == "substrate" else from_id)
        if candidate.className == "Reac":
            reac_elem = candidate
            old_sub_order, old_prd_order = _reac_orders(reac_elem)

    if edge_type == "substrate":
        moose.connect(moose.element(to_id), "sub", moose.element(from_id), "reac")
        stoich = sum(1 for n in moose.element(to_id).neighbors["sub"] if n.path == from_id)
    elif edge_type == "product":
        moose.connect(moose.element(from_id), "prd", moose.element(to_id), "reac")
        stoich = sum(1 for n in moose.element(from_id).neighbors["prd"] if n.path == to_id)
    elif edge_type == "chanIn":
        # A ConcChan's two exchange partners are wired after the fact via
        # ordinary drag-to-connect, unlike its structural parent pool (set
        # at creation, see create_concchan) -- mirrors substrate/product's
        # own pool-to/from-reac shape exactly (chan plays the reac/enz role).
        moose.connect(moose.element(to_id), "in", moose.element(from_id), "reac")
        stoich = sum(1 for n in moose.element(to_id).neighbors["in"] if n.path == from_id)
    elif edge_type == "chanOut":
        moose.connect(moose.element(from_id), "out", moose.element(to_id), "reac")
        stoich = sum(1 for n in moose.element(from_id).neighbors["out"] if n.path == to_id)
    elif edge_type == "funcInput":
        func = moose.element(to_id)
        if func.className != "Function":
            return jsonify({"error": "funcInput target must be a function"}), 400
        kind = body.get("kind")
        if kind not in ("sum", "general"):
            return jsonify({"error": f"unsupported funcInput kind: {kind}"}), 400
        # A Function's own "x" is a single DATA element but a multi-slot
        # FIELD-indexed one -- func.x[i] all share the same data index,
        # only fieldIndex actually differs between them (verified
        # directly; moose's own test_function_change_expr.py connects
        # this exact way). A bare moose.element(func.path + "/x")
        # (what this used to do) always resolves to fieldIndex 0
        # regardless of which input this is, which silently means every
        # input after the first overwrites the same single slot instead
        # of actually occupying its own x0/x1/... -- verified directly:
        # this was why a summation/general function's OUTPUT never
        # tracked its real inputs at all once actually simulated, even
        # though _function_inputs' own read-back (a plain neighbor list,
        # not fieldIndex-sensitive) already reported the connections
        # correctly, masking the bug from every check this app ran before
        # actually running a live simulation.
        slot = len(_function_inputs(func))
        if slot >= func.numVars:
            func.numVars = slot + 1
        moose.connect(moose.element(from_id), "nOut", func.x[slot], "input")
        input_ids = _function_inputs(func)
        if kind == "sum":
            # A summation function's own expr is ALWAYS kept in lockstep
            # with however many inputs are actually wired -- see
            # describe_stim's own classifier, which relies on this never
            # drifting apart.
            set_func_expr(func, "+".join(f"x{i}" for i in range(len(input_ids))))
        stoich = 1  # never a parallel/stoichiometric connection the way substrate/product can be
    else:
        return jsonify({"error": f"unsupported edge type: {edge_type}"}), 400

    reac_update = None
    if reac_elem is not None:
        rescale_reac_for_order_change(
            reac_elem, old_sub_order, old_prd_order, "sub" if edge_type == "substrate" else "prd"
        )
        reac_update = describe_reac(reac_elem.path)

    # A funcInput connection can change the target function's own numVars/
    # expr (see the branch above) -- reported back the same way reacUpdate
    # is, so the frontend can patch that one node's data without a full
    # graph refetch.
    func_update = describe_stim(to_id) if edge_type == "funcInput" else None

    # Connecting an already-connected reac/enz-pool pair again (kkit's way of
    # expressing stoichiometry > 1, e.g. "2A -> B") adds another separate
    # message rather than erroring or being a no-op -- reporting the new
    # total lets the frontend update one edge's label instead of drawing a
    # second, fully-overlapping edge.
    return jsonify({"ok": True, "stoich": stoich, "reacUpdate": reac_update, "funcUpdate": func_update})


_EDGE_SRC_FIELD = {
    "substrate": "subOut", "product": "prdOut",
    "chanIn": "inPoolOut", "chanOut": "outPoolOut",
}


@app.post("/api/remove_edge")
def remove_edge():
    body = request.json or {}
    from_id, to_id, edge_type = body.get("from"), body.get("to"), body.get("type")
    if edge_type == "funcInput":
        err = _validate_edge_ids(from_id, to_id)
        if err:
            return jsonify({"error": err}), 400
        func = moose.element(to_id)
        pool_id = from_id
        before = _function_inputs(func)
        if pool_id not in before:
            return jsonify({"error": "connection not found"}), 404
        declared_capacity = func.numVars
        remaining = [p for p in before if p != pool_id]
        # Deleting only the ONE message for `pool_id` (whichever field-
        # indexed slot it happened to occupy, see add_edge's own
        # func.x[i] comment) can leave a GAP in the middle of the 0..N-1
        # slot range -- every remaining input is instead disconnected and
        # reconnected fresh, in the same relative order, to a contiguous
        # range, which is what actually keeps the simulation's own real
        # x0/x1/... reading exactly the same pools _function_inputs' own
        # read-back (and this app's own UI) reports (verified directly:
        # leaving a gap in place left the function's own live value
        # permanently stuck at whatever it was before the removal, still
        # counting the just-removed input).
        #
        # Each existing input's own message is found via ITS OWN msgOut
        # (the pool's outgoing side), the same narrow, per-input lookup
        # the single-message delete used before this whole reconnect-
        # everything approach -- enumerating from the DESTINATION side
        # instead (func's own "x" child's msgIn) crashed outright
        # (verified directly, a segfault) on an unrelated internal entry
        # moose itself apparently keeps there alongside the real input
        # messages.
        for p in before:
            pool_elem = moose.element(p)
            for m in pool_elem.msgOut:
                msg = moose.element(m)
                if "input" in msg.destFieldsOnE2 and moose.element(msg.e2).parent.path == func.path:
                    moose.delete(msg)
                    break
        func.numVars = 0
        for i, p in enumerate(remaining):
            func.numVars = i + 1
            moose.connect(moose.element(p), "nOut", func.x[i], "input")
        kind = body.get("kind")
        if kind == "sum":
            # A summation function's own expr/numVars stay in lockstep
            # with however many inputs are actually wired -- see
            # add_edge's own matching comment.
            set_func_expr(func, "+".join(f"x{i}" for i in range(len(remaining))))
        else:
            # A general function's own declared capacity (numInputs) is
            # left exactly as it was -- removing one connection just
            # frees that slot up again, it doesn't shrink how many the
            # node is set up to handle (see update_stim's own numInputs
            # handling).
            func.numVars = max(func.numVars, declared_capacity)
        return jsonify({"ok": True, "numInputs": func.numVars, "funcUpdate": describe_stim(func.path)})

    if edge_type not in _EDGE_SRC_FIELD:
        return jsonify({"error": f"unsupported edge type: {edge_type}"}), 400
    err = _validate_edge_ids(from_id, to_id)
    if err:
        return jsonify({"error": err}), 400

    reac_or_enz_id = to_id if edge_type in ("substrate", "chanIn") else from_id
    pool_id = from_id if edge_type in ("substrate", "chanIn") else to_id
    src_field = _EDGE_SRC_FIELD[edge_type]

    reac_elem, old_sub_order, old_prd_order = None, None, None
    if edge_type in ("substrate", "product"):
        candidate = moose.element(reac_or_enz_id)
        if candidate.className == "Reac":
            reac_elem = candidate
            old_sub_order, old_prd_order = _reac_orders(reac_elem)

    def _matches(msg):
        return src_field in msg.srcFieldsOnE1 and moose.element(msg.e2).path == pool_id

    deleted = False
    for m in moose.element(reac_or_enz_id).msgOut:
        msg = moose.element(m)
        if _matches(msg):
            moose.delete(msg)
            deleted = True
            break

    if not deleted:
        return jsonify({"error": "connection not found"}), 404

    reac_update = None
    if reac_elem is not None:
        rescale_reac_for_order_change(
            reac_elem, old_sub_order, old_prd_order, "sub" if edge_type == "substrate" else "prd"
        )
        reac_update = describe_reac(reac_elem.path)

    # Only one message is ever deleted per call -- a stoichiometry > 1
    # connection is multiple separate messages between the same reac/enz and
    # pool (see build_graph's grouping), so this decrements by exactly one.
    # Reporting the remaining count lets the frontend update (or remove) the
    # edge's stoichiometry label without a full graph refetch.
    remaining = sum(1 for m in moose.element(reac_or_enz_id).msgOut if _matches(moose.element(m)))
    return jsonify({"ok": True, "stoich": remaining, "reacUpdate": reac_update})


def _container_path(parent_id=None):
    """New pools/reacs/groups/compartments are created under an explicit
    group/compartment when one is given (dropped into its box on the
    canvas); otherwise under the model's default 'kinetics' compartment, or
    the model root if that's somehow missing."""
    if parent_id is not None:
        return parent_id
    kinetics = _current_model_path + "/kinetics"
    return kinetics if moose.exists(kinetics) else _current_model_path


def _validate_parent_id(parent_id):
    if parent_id is None:
        return None
    if not parent_id.startswith(_current_model_path) or not moose.exists(parent_id):
        return f"invalid parent container: {parent_id}"
    return None


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
    parent_id = body.get("parentId")
    err = _validate_parent_id(parent_id)
    if err:
        return jsonify({"error": err}), 400
    container = _container_path(parent_id)
    name = _unique_name(container, body.get("name") or "pool")
    p = moose.Pool(f"{container}/{name}")
    create_info(p.path, float(body.get("x", 0)), float(body.get("y", 0)))
    result = describe_pool(p.path)
    result["parentId"] = container_parent_id(p.path, _current_model_path)
    return jsonify(result)


@app.post("/api/create_reac")
def create_reac():
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    body = request.json or {}
    parent_id = body.get("parentId")
    err = _validate_parent_id(parent_id)
    if err:
        return jsonify({"error": err}), 400
    container = _container_path(parent_id)
    name = _unique_name(container, body.get("name") or "reac")
    r = moose.Reac(f"{container}/{name}")
    r.Kf, r.Kb = 0.1, 0.1
    create_info(r.path, float(body.get("x", 0)), float(body.get("y", 0)))
    result = describe_reac(r.path)
    result["parentId"] = container_parent_id(r.path, _current_model_path)
    return jsonify(result)


@app.post("/api/create_group")
def create_group():
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    body = request.json or {}
    parent_id = body.get("parentId")
    err = _validate_parent_id(parent_id)
    if err:
        return jsonify({"error": err}), 400
    container = _container_path(parent_id)
    name = _unique_name(container, body.get("name") or "group")
    g = moose.Neutral(f"{container}/{name}")
    create_info(
        g.path,
        float(body.get("x", 0)),
        float(body.get("y", 0)),
        width=float(body.get("width", 4.0)),
        height=float(body.get("height", 3.0)),
    )
    result = describe_group(g.path)
    result["parentId"] = container_parent_id(g.path, _current_model_path)
    return jsonify(result)


@app.post("/api/create_compartment")
def create_compartment():
    """Compartments never nest (parentId is always ignored/absent) -- always
    created directly under the model root, alongside the default 'kinetics'
    compartment every model already has."""
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    body = request.json or {}
    name = _unique_name(_current_model_path, body.get("name") or "compartment")
    c = moose.CubeMesh(f"{_current_model_path}/{name}")
    c.volume = float(body.get("volume", 1.6667e-21))
    create_info(
        c.path,
        float(body.get("x", 0)),
        float(body.get("y", 0)),
        width=float(body.get("width", 8.0)),
        height=float(body.get("height", 6.0)),
    )
    result = describe_compartment(c.path)
    result["parentId"] = None
    return jsonify(result)


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
    if is_enz_complex(parent_id):
        return jsonify({"error": "an enzyme's complex pool can't be connected to anything"}), 400

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


@app.post("/api/create_concchan")
def create_concchan():
    """A ConcChan is structurally nested under its 'parent' pool -- the one
    whose abundance drives the channel (see moose_graph.describe_concchan)
    -- exactly like an enzyme is nested under its substrate. Its actual
    exchange partners (in/out pools) are wired afterward via ordinary
    drag-to-connect (see add_edge's chanIn/chanOut handling), not at
    creation time -- a single drop can only designate one pool."""
    body = request.json or {}
    parent_id = body.get("parentPoolId")
    if _current_model_path is None or not parent_id or not parent_id.startswith(_current_model_path):
        return jsonify({"error": "invalid or missing parent pool"}), 400
    if not moose.exists(parent_id):
        return jsonify({"error": f"parent pool not found: {parent_id}"}), 404
    if is_enz_complex(parent_id):
        return jsonify({"error": "an enzyme's complex pool can't be connected to anything"}), 400

    parent = moose.element(parent_id)
    name = _unique_name(parent_id, body.get("name") or "pore")
    c = moose.ConcChan(f"{parent_id}/{name}")
    c.permeability = 1.0
    moose.connect(parent, "nOut", c, "setNumChan")
    create_info(c.path, float(body.get("x", 0)), float(body.get("y", 0)))
    return jsonify(describe_concchan(c.path))


@app.post("/api/update_concchan")
def update_concchan():
    body = request.json or {}
    return _update_node(
        body.get("id"), body.get("fields", {}), {"permeability"}, set(), describe_concchan
    )


_STIM_CHECK_SCRIPT = """
import json, sys
import moose

expr = sys.argv[1]
runtime = float(sys.argv[2])
n_samples = 100
dt = runtime / n_samples

moose.Neutral("/check")
func = moose.Function("/check/f")
func.expr = expr
func.mode = 1
tab = moose.Table2("/check/t")
moose.connect(tab, "requestOut", func, "getValue")
moose.setClock(0, dt)
moose.useClock(0, "/check/##", "process")
moose.reinit()
moose.start(runtime)
print(json.dumps([float(v) for v in tab.vector]))
"""


def _check_stim_expr(expr, runtime):
    """Evaluates `expr` (a Stimulus's muParser expression, a function of t)
    at 100 samples across [0, runtime] and reports whether any sampled
    value is negative -- an illegal concentration. Run as a completely
    separate OS process (its own moose instance) rather than in-process:
    moose.start() advances every object on every currently-scheduled clock
    globally, not just a chosen subtree, so evaluating this in-process
    would also silently re-advance the live model's own solver/plot tables
    if they're still scheduled from a previous run (verified directly that
    Ksolve/Table2 stay attached to their ticks after a run completes) --
    corrupting the live session's actual concentrations as a side effect of
    what's meant to be a read-only check."""
    try:
        proc = subprocess.run(
            [sys.executable, "-c", _STIM_CHECK_SCRIPT, expr, str(runtime)],
            capture_output=True, text=True, timeout=15,
        )
    except subprocess.TimeoutExpired:
        return "stimulus check timed out", None
    if proc.returncode != 0:
        last_line = proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else "invalid expression"
        return f"invalid expression: {last_line}", None
    try:
        values = json.loads(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return "could not evaluate expression", None
    negative = [v for v in values if v < 0]
    if negative:
        return (
            f"expression goes negative (e.g. {negative[0]:.4g}) somewhere between "
            f"t=0 and t={runtime} -- concentrations can't be negative",
            None,
        )
    return None, values


@app.post("/api/check_stim")
def check_stim():
    body = request.json or {}
    expr = body.get("expr", "")
    try:
        runtime = float(body.get("runtime", 1.0))
    except (TypeError, ValueError):
        return jsonify({"error": "runtime must be a number"}), 400
    if runtime <= 0:
        return jsonify({"error": "runtime must be positive"}), 400
    error, _ = _check_stim_expr(expr, runtime)
    if error:
        return jsonify({"error": error}), 400
    return jsonify({"ok": True})


_STIM_FIELD_BY_BUFFERED = {True: "setConcInit", False: "setConc"}


@app.post("/api/create_stim")
def create_stim():
    """A Stimulus is a moose.Function whose valueOut drives a target pool's
    conc (or concInit, if the pool is buffered) -- see jardesigner's
    _buildOneStim, the same mechanism this mirrors. Nested directly under
    the target pool itself, matching how create_enz/create_concchan already
    nest an enzyme/channel under their own parent pool -- so deleting the
    pool deletes this along with it via moose's own ordinary recursive
    subtree delete, no separate cascade-delete code needed (see
    delete_node), and container_parent_id's own walk-past-non-container-
    ancestors logic (already relied on for enz/concChan) places this at
    exactly the same group/compartment in the diagram a sibling would have."""
    body = request.json or {}
    target_id = body.get("targetId")
    if _current_model_path is None or not target_id or not target_id.startswith(_current_model_path):
        return jsonify({"error": "invalid or missing target pool"}), 400
    if not moose.exists(target_id):
        return jsonify({"error": f"target pool not found: {target_id}"}), 404
    if is_enz_complex(target_id):
        return jsonify({"error": "an enzyme's complex pool can't be connected to anything"}), 400

    expr = body.get("expr") or "0"
    try:
        runtime = float(body.get("runtime", 1.0))
    except (TypeError, ValueError):
        return jsonify({"error": "runtime must be a number"}), 400
    error, _ = _check_stim_expr(expr, runtime)
    if error:
        return jsonify({"error": error}), 400

    target = moose.element(target_id)
    container = target.path
    name = _unique_name(container, body.get("name") or "stim")
    func = moose.Function(f"{container}/{name}")
    func.doEvalAtReinit = True
    dest_field = _STIM_FIELD_BY_BUFFERED[bool(target.isBuffered)]
    moose.connect(func, "valueOut", target, dest_field)
    set_func_expr(func, expr)
    create_info(func.path, float(body.get("x", 0)), float(body.get("y", 0)), color="red")
    return jsonify(describe_stim(func.path))


def _create_target_pool(body):
    """Shared by create_sumfunc/create_genfunc -- both drive a target pool
    exactly the way create_stim's own target/container/dest_field logic
    already does; factored out once here rather than copied a second and
    third time."""
    target_id = body.get("targetId")
    if _current_model_path is None or not target_id or not target_id.startswith(_current_model_path):
        return None, (jsonify({"error": "invalid or missing target pool"}), 400)
    if not moose.exists(target_id):
        return None, (jsonify({"error": f"target pool not found: {target_id}"}), 404)
    if is_enz_complex(target_id):
        return None, (jsonify({"error": "an enzyme's complex pool can't be connected to anything"}), 400)
    return moose.element(target_id), None


@app.post("/api/create_sumfunc")
def create_sumfunc():
    """A summation function is a plain moose.Function whose expr is always
    kept as the exact "x0+x1+..." pattern for however many pool inputs are
    currently wired (see add_edge's own funcInput handling) -- never
    independently user-edited, unlike create_genfunc. Dropped onto a
    target pool the same way create_stim is (drives conc/concInit)."""
    body = request.json or {}
    target, err = _create_target_pool(body)
    if err:
        return err

    container = target.path
    name = _unique_name(container, body.get("name") or "sum")
    func = moose.Function(f"{container}/{name}")
    # No inputs wired yet -- add_edge rewrites both the moment the first
    # one connects. allowUnknownVariable=False is the same restriction
    # ReadKkit.cpp's own buildSumTotal applies: only x0, x1, ... (its own
    # wired inputs) are ever legal names in a summation's expr.
    func.allowUnknownVariable = False
    func.doEvalAtReinit = True
    dest_field = _STIM_FIELD_BY_BUFFERED[bool(target.isBuffered)]
    moose.connect(func, "valueOut", target, dest_field)
    set_func_expr(func, "0")
    create_info(func.path, float(body.get("x", 0)), float(body.get("y", 0)), color="red")
    return jsonify(describe_stim(func.path))


@app.post("/api/create_genfunc")
def create_genfunc():
    """A general function is a plain moose.Function with a user-authored
    expr and a fixed (but user-adjustable, see update_stim's own
    numInputs handling) number of pool-input slots, referenced in its own
    expr as x0, x1, .... Dropped onto a target pool the same way
    create_stim/create_sumfunc are."""
    body = request.json or {}
    target, err = _create_target_pool(body)
    if err:
        return err
    try:
        num_inputs = int(body.get("numInputs", 2))
    except (TypeError, ValueError):
        return jsonify({"error": "numInputs must be a whole number"}), 400
    if num_inputs < 0:
        return jsonify({"error": "numInputs can't be negative"}), 400

    container = target.path
    name = _unique_name(container, body.get("name") or "func")
    func = moose.Function(f"{container}/{name}")
    func.numVars = num_inputs
    func.doEvalAtReinit = True
    dest_field = _STIM_FIELD_BY_BUFFERED[bool(target.isBuffered)]
    moose.connect(func, "valueOut", target, dest_field)
    set_func_expr(func, "0")
    create_info(func.path, float(body.get("x", 0)), float(body.get("y", 0)), color="red")
    return jsonify(describe_stim(func.path))


@app.post("/api/update_stim")
def update_stim():
    body = request.json or {}
    node_id = body.get("id")
    fields = dict(body.get("fields", {}))
    if _current_model_path is None or not node_id or not node_id.startswith(_current_model_path):
        return jsonify({"error": "invalid or stale node id"}), 400
    if not moose.exists(node_id):
        return jsonify({"error": f"node not found: {node_id}"}), 404

    f = moose.element(node_id)
    # _check_stim_expr samples the expression as a pure function of t --
    # only meaningful for a genuine zero-input stimulus. A general
    # function's own expr depends on its live pool inputs (x0, x1, ...),
    # not just t, so there's nothing meaningful to pre-sample here; a
    # summation function never has a user-editable expr in the first
    # place (see describe_stim/add_edge's own funcInput handling), so
    # this never actually runs for one regardless. Same "is this actually
    # a plain stim" condition describe_stim's own classifier uses --
    # NOT `_function_inputs(f)` (actually-wired count), which a general
    # function's own declared-but-not-yet-wired capacity (numVars>0,
    # nothing connected yet) would otherwise slip past, wrongly running
    # this stim-only check against an expr that references x0/x1 the
    # check has no way to supply real values for (verified directly: a
    # freshly dropped general function's own default numInputs=2, zero
    # wired, tripped exactly this before the numVars check was added).
    is_genuine_stim = f.allowUnknownVariable and f.numVars == 0
    if "expr" in fields and is_genuine_stim:
        try:
            runtime = float(body.get("runtime", 1.0))
        except (TypeError, ValueError):
            return jsonify({"error": "runtime must be a number"}), 400
        error, _ = _check_stim_expr(fields["expr"], runtime)
        if error:
            return jsonify({"error": error}), 400

    # A general function's own "how many inputs it handles" (see
    # PropertiesMenuBox's numInputs field) -- not a plain numeric field
    # _update_node can just setattr, since shrinking it needs to refuse
    # ever orphaning an already-wired input.
    if "numInputs" in fields:
        try:
            new_count = int(fields.pop("numInputs"))
        except (TypeError, ValueError):
            return jsonify({"error": "numInputs must be a whole number"}), 400
        if new_count < 0:
            return jsonify({"error": "numInputs can't be negative"}), 400
        wired = len(_function_inputs(f))
        if new_count < wired:
            return jsonify({"error": f"can't reduce below {wired} -- that many inputs are already wired"}), 400
        f.numVars = new_count

    # expr always goes through set_func_expr (never a plain setattr, see
    # its own docstring) so a general function's user-authored, clean
    # concentration-domain expr (e.g. "x0*x1+2") gets the same scaling
    # correction applied at creation time and by add_edge/remove_edge's
    # own funcInput handling -- otherwise editing an existing general
    # function's expr through this endpoint would silently install it
    # unscaled, right back into the same 1000x-plus-too-large bug this
    # was written to fix.
    if "expr" in fields:
        set_func_expr(f, fields.pop("expr"))

    return _update_node(node_id, fields, set(), set(), describe_stim, string_fields=set())


@app.post("/api/delete_node")
def delete_node():
    body = request.json or {}
    node_id = body.get("id")
    if _current_model_path is None or not node_id or not node_id.startswith(_current_model_path):
        return jsonify({"error": "invalid or stale node id"}), 400
    if not moose.exists(node_id):
        return jsonify({"error": f"node not found: {node_id}"}), 404
    if is_enz_complex(node_id):
        return jsonify({"error": "an enzyme's complex pool can't be deleted on its own -- delete the enzyme instead"}), 400
    moose.delete(node_id)
    return jsonify({"ok": True})


@app.post("/api/run/start")
def run_start():
    """Runs the simulation to completion and returns the full time course in
    one response -- synchronous for now, no live/incremental streaming."""
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    body = request.json or {}
    try:
        runtime = float(body.get("runtime", 1.0))
        plot_dt = float(body.get("plotDt", 0.01))
    except (TypeError, ValueError):
        return jsonify({"error": "runtime and plotDt must be numbers"}), 400
    if runtime <= 0 or plot_dt <= 0:
        return jsonify({"error": "runtime and plotDt must be positive"}), 400

    result = run_simulation(_current_model_path, runtime, plot_dt)
    return jsonify(result)


@app.post("/api/run/reset")
def run_reset():
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    moose.reinit()
    return jsonify(build_graph(_current_model_path))


@app.get("/api/dose_response/decades")
def dose_response_decades():
    return jsonify({"labels": DOSE_DECADE_LABELS})


# A single dose-response run in progress, one HTTP request per dose level
# (see /step) rather than one all-in-one blocking request -- lets the
# frontend show progress and halt between levels. Global/single-session,
# matching _current_model_path's own single-active-model design.
_dose_session = None


@app.post("/api/dose_response/start")
def dose_response_start():
    global _dose_session
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    body = request.json or {}
    input_id = body.get("inputId")
    output_id = body.get("outputId")
    if (
        not input_id or not output_id
        or not input_id.startswith(_current_model_path) or not output_id.startswith(_current_model_path)
        or not moose.exists(input_id) or not moose.exists(output_id)
    ):
        return jsonify({"error": "pick both a variable pool and a monitored pool"}), 400
    try:
        min_decade = int(body.get("minDecade"))
        max_decade = int(body.get("maxDecade"))
        runtime = float(body.get("runtime", 100))
    except (TypeError, ValueError):
        return jsonify({"error": "invalid numeric input"}), 400
    if not (0 <= min_decade <= 7 and 0 <= max_decade <= 7):
        return jsonify({"error": "concentration decade out of range"}), 400
    if runtime <= 0:
        return jsonify({"error": "runtime must be positive"}), 400
    if min_decade > max_decade:
        min_decade, max_decade = max_decade, min_decade

    concs = dose_concentrations(min_decade, max_decade, bool(body.get("fine")))
    if body.get("decreasing"):
        concs = list(reversed(concs))

    _dose_session = start_dose_response(
        _current_model_path, input_id, output_id, concs, runtime,
        bool(body.get("buffered")), bool(body.get("resetEachLevel")),
    )
    return jsonify({"total": len(concs)})


@app.post("/api/dose_response/step")
def dose_response_step():
    global _dose_session
    if _dose_session is None:
        return jsonify({"error": "no dose-response run in progress"}), 400
    result = step_dose_response(_dose_session)
    if result is None:
        finish_dose_response(_dose_session)
        _dose_session = None
        return jsonify({"done": True})
    done = _dose_session["index"] >= len(_dose_session["concs"])
    if done:
        finish_dose_response(_dose_session)
        _dose_session = None
    return jsonify({"result": result, "done": done})


@app.post("/api/dose_response/halt")
def dose_response_halt():
    global _dose_session
    if _dose_session is not None:
        finish_dose_response(_dose_session)
        _dose_session = None
    return jsonify({"ok": True})


@app.post("/api/findsim/parse")
def findsim_parse():
    """Validates+normalizes an uploaded FindSim experiment file (see
    findsim_runner.py's own module docstring for scope) and auto-matches
    its Stimuli/Readouts entities against the currently loaded model's
    pools by exact name/alias, so the frontend can show a summary and let
    the user fill in any unmatched entity from a dropdown before running."""
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    content = (request.json or {}).get("content")
    if not content:
        return jsonify({"error": "no file content provided"}), 400
    try:
        spec = json.loads(content)
    except json.JSONDecodeError as e:
        return jsonify({"error": f"not valid JSON: {e}"}), 400
    try:
        parsed = parse_findsim_spec(spec)
        matched, pool_options = resolve_entities(parsed, _current_model_path)
    except FindSimError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({
        "design": parsed["design"],
        "stimuli": [{"id": s["id"], "entityName": s["entityName"], "alias": s["alias"]} for s in parsed["stimuli"]],
        "readout": {
            "id": parsed["readout"]["id"],
            "entityName": parsed["readout"]["entityName"],
            "alias": parsed["readout"]["alias"],
        },
        "matched": matched,
        "poolOptions": pool_options,
        "spec": spec,
    })


@app.post("/api/findsim/run")
def findsim_run():
    """Runs a previously-parsed FindSim spec (re-sent verbatim, along with
    the entity->pool mapping the frontend collected/confirmed) against the
    currently loaded model."""
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    body = request.json or {}
    spec = body.get("spec")
    entity_map = body.get("entityMap") or {}
    try:
        parsed = parse_findsim_spec(spec)
        result = run_findsim(_current_model_path, parsed, entity_map)
    except FindSimError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(result)


@app.post("/api/save_sbml")
def save_sbml():
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    body = request.json or {}
    notes = body.get("notes", "") if request.is_json else ""
    plots = body.get("plots") or {}
    runtime = body.get("runtime")
    plot_dt = body.get("plotDt")
    collapsed = body.get("collapsed") or {}
    creator = body.get("creator", "")
    license_ = body.get("license", "")
    # The "last modified" timestamp is purely informational (shown back to
    # the user in the File menu's own read-only dialog, see FileMenuBox) --
    # like notes/runtime/plotDt, this app trusts whatever the client sends
    # rather than re-deriving it server-side, since there's no invariant
    # depending on it actually being accurate to the second.
    modified = body.get("modified", "")
    snapshot = _snapshot_positions(_current_model_path)
    group_snapshot = _snapshot_group_boxes(_current_model_path)
    stim_snapshot = _snapshot_stims(_current_model_path)
    fd, path = tempfile.mkstemp(suffix=".xml")
    os.close(fd)
    moose.writeSBML(_current_model_path, path)
    with open(path) as f:
        content = f.read()
    os.remove(path)
    _restore_positions(snapshot)
    content = _fix_positions_in_sbml(content, snapshot)
    content = _fix_group_positions_in_sbml(content, group_snapshot)
    content = _fix_missing_reaction_group_memberships(content)
    content = _inject_plot_annotations(content, _current_model_path, plots)
    content = _inject_stim_annotations(content, _current_model_path, stim_snapshot)
    content = _inject_collapsed_annotations(content, _current_model_path, collapsed)
    have_meta = creator or license_ or modified
    if notes or (runtime is not None and plot_dt is not None) or have_meta:
        doc = libsbml.readSBMLFromString(content)
        model = doc.getModel()
        if notes:
            model.setNotes(_wrap_notes(notes))
        # Both custom model-level annotations have to go in through a
        # SINGLE setAnnotation call -- it replaces the model's whole
        # annotation block rather than appending to it (confirmed
        # directly), so building one combined string here is the only way
        # runSettings and modelMeta both survive together.
        annotation = ""
        if runtime is not None and plot_dt is not None:
            # The user's preferred Run-panel settings -- not part of the
            # model itself, so a plain custom model-level annotation
            # (same mechanism as the per-species plotWindow/stimulus
            # annotations) rather than any native SBML construct.
            annotation += f'<kkit:runSettings xmlns:kkit="{_KKIT_NS}" runtime="{runtime}" plotDt="{plot_dt}"/>'
        if have_meta:
            annotation += (
                f'<kkit:modelMeta xmlns:kkit="{_KKIT_NS}" creator="{html.escape(creator)}" '
                f'license="{html.escape(license_)}" modified="{html.escape(modified)}"/>'
            )
        if annotation:
            model.setAnnotation(annotation)
        content = libsbml.writeSBMLToString(doc)
    return jsonify({"sbml": content})


_RUN_SETTINGS_RE = re.compile(r'<kkit:runSettings\b[^>]*\bruntime="([^"]*)"[^>]*\bplotDt="([^"]*)"')
_MODEL_META_RE = re.compile(
    r'<kkit:modelMeta\b[^>]*\bcreator="([^"]*)"[^>]*\blicense="([^"]*)"[^>]*\bmodified="([^"]*)"'
)


@app.post("/api/load_sbml")
def load_sbml():
    content = request.json.get("sbml")
    if not content:
        return jsonify({"error": "no sbml content provided"}), 400
    notes = ""
    run_settings = None
    model_meta = None
    doc = libsbml.readSBMLFromString(content)
    model = doc.getModel()
    if model is not None:
        notes = _unwrap_notes(model.getNotesString())
        annotation = model.getAnnotationString() or ""
        m = _RUN_SETTINGS_RE.search(annotation)
        if m:
            run_settings = {"runtime": m.group(1), "plotDt": m.group(2)}
        m = _MODEL_META_RE.search(annotation)
        if m:
            model_meta = {
                "creator": html.unescape(m.group(1)),
                "license": html.unescape(m.group(2)),
                "modified": html.unescape(m.group(3)),
            }
    content_for_moose = _ensure_reaction_present(content, model)
    fd, path = tempfile.mkstemp(suffix=".xml")
    with os.fdopen(fd, "w") as f:
        f.write(content_for_moose)
    model_path = _new_model_path()
    _, load_error = moose.readSBML(path, model_path)
    os.remove(path)
    if load_error:
        return jsonify({"error": f"could not load SBML: {load_error.strip()}"}), 400
    _strip_dummy_reaction(model_path)
    _restore_group_annotations(doc, model_path)
    _restore_stims(doc, model_path)
    extra_plot_windows = _extract_plot_windows(content, model_path)
    extra_collapsed = _extract_collapsed(content, model_path)
    result = build_graph(model_path, extra_plot_windows, extra_collapsed)
    result["notes"] = notes
    result["runSettings"] = run_settings
    result["modelMeta"] = model_meta
    return jsonify(result)


@app.get("/api/tools/model_size")
def tools_model_size():
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    return jsonify(model_size(_current_model_path))


@app.post("/api/tools/find_dt")
def tools_find_dt():
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    body = request.json or {}
    try:
        err = float(body.get("err", 0.01))
    except (TypeError, ValueError):
        return jsonify({"error": "err must be a number"}), 400
    return jsonify(find_dt(_current_model_path, err))


@app.post("/api/tools/compare_groups")
def tools_compare_groups():
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    body = request.json or {}
    root_a, root_b = body.get("rootA"), body.get("rootB")
    if (
        not root_a or not root_b
        or not root_a.startswith(_current_model_path) or not root_b.startswith(_current_model_path)
        or not moose.exists(root_a) or not moose.exists(root_b)
    ):
        return jsonify({"error": "invalid comparison groups"}), 400
    return jsonify(compare_groups(root_a, root_b))


@app.post("/api/tools/compare_file")
def tools_compare_file():
    """Loads a second .g/SBML file into a hidden side model purely to
    diff against the current one (see model_tools.compare_groups) --
    never added to the canvas, deleted again as soon as the comparison is
    done, mirroring the original xcomparemodel.g's "compare against a
    file" mode without needing Genesis's own re-entrant-parsing
    workaround."""
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    body = request.json or {}
    content = body.get("content")
    filetype = body.get("fileType")
    root_a = body.get("rootA") or _current_model_path
    if not content:
        return jsonify({"error": "no file content provided"}), 400
    if not root_a.startswith(_current_model_path) or not moose.exists(root_a):
        return jsonify({"error": "invalid comparison root"}), 400

    side_path = f"/__compare_side_{next(_path_counter)}"
    if filetype == "g":
        fd, path = tempfile.mkstemp(suffix=".g")
        with os.fdopen(fd, "w") as f:
            f.write(content)
        moose.loadModel(path, side_path, "ee")
        os.remove(path)
    else:
        doc = libsbml.readSBMLFromString(content)
        content_for_moose = _ensure_reaction_present(content, doc.getModel())
        fd, path = tempfile.mkstemp(suffix=".xml")
        with os.fdopen(fd, "w") as f:
            f.write(content_for_moose)
        _, load_error = moose.readSBML(path, side_path)
        os.remove(path)
        if load_error:
            if moose.exists(side_path):
                moose.delete(side_path)
            return jsonify({"error": f"could not load comparison file: {load_error.strip()}"}), 400
        _strip_dummy_reaction(side_path)

    if not moose.exists(side_path):
        return jsonify({"error": "could not load comparison file"}), 400
    try:
        result = compare_groups(root_a, side_path)
    finally:
        if moose.exists(side_path):
            moose.delete(side_path)
    return jsonify(result)


@app.post("/api/tools/report")
def tools_report():
    if _current_model_path is None or not moose.exists(_current_model_path):
        return jsonify({"error": "no model loaded"}), 400
    body = request.json or {}
    fmt = body.get("format", "markdown")
    try:
        content = render_report(_current_model_path, fmt)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"content": content})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True)
