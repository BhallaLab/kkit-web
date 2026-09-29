import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  FormControlLabel,
  Checkbox,
  Button,
  Grid,
  Divider,
  Chip,
  Tooltip,
  LinearProgress,
  ToggleButtonGroup,
  ToggleButton,
} from '@mui/material';
import { RAINBOW_16, GRAYSCALE_8 } from '../../colorUtils';
import {
  conc as concUnitConv,
  time as timeUnitConv,
  volume as volumeUnitConv,
  length as lengthUnitConv,
  rateConstantToDisplay,
  rateConstantToNative,
  rateConstantUnitLabel,
  timeRateToDisplay,
  timeRateToNative,
  timeRateUnitLabel,
  numRateUnitLabel,
  timeUnitAbbrev,
  diffConstToDisplay,
  diffConstToNative,
  diffConstUnitLabel,
  motorConstToDisplay,
  motorConstToNative,
  motorConstUnitLabel,
  permeabilityToDisplay,
  permeabilityToNative,
  permeabilityUnitLabel,
  fluxUnitLabel,
} from '../../unitConversions';
import { TOGGLE_GROUP_SX } from '../../menuStyle';

// Which unit-conversion "kind" a given (node type, field key) pair needs
// -- everything not listed here (n/nInit, ratio, ConcChan.numChan -- plain
// dimensionless counts, same as n/nInit) passes through unconverted, in
// whatever native units the backend already returns (see moose_graph.py's
// describe_pool/describe_reac/describe_enz/describe_concchan).
function fieldKind(node, key) {
  if (node.type === 'pool' && (key === 'conc' || key === 'concInit')) return 'conc';
  if (node.type === 'pool' && key === 'diffConst') return 'diffConst';
  if (node.type === 'pool' && key === 'motorConst') return 'motorConst';
  if (node.type === 'compartment' && key === 'volume') return 'volume';
  if (node.type === 'compartment' && key === 'diameter') return 'length';
  if (node.type === 'concchan') {
    if (key === 'permeability') return 'permeability';
    if (key === 'flux') return 'flux';
  }
  if (node.type === 'reac') {
    if (key === 'Kf') return { kind: 'rate', order: node.data.subOrder };
    if (key === 'Kb') return { kind: 'rate', order: node.data.prdOrder };
    if (key === 'numKf') return { kind: 'numrate', order: node.data.subOrder };
    if (key === 'numKb') return { kind: 'numrate', order: node.data.prdOrder };
    if (key === 'tau') return 'time';
    // Keq (sub_order === prd_order) is dimensionless -- never scaled,
    // regardless of which concentration unit is selected; a real Kd is a
    // single (order-independent) concentration power, the same
    // conversion a plain concentration value gets.
    if (key === 'kd') return node.data.kdLabel === 'Keq' ? null : 'conc';
  }
  if (node.type === 'enz') {
    if (key === 'Km') return 'conc';
    // concK1 is k1's concentration-based counterpart (see describe_enz's
    // own comment) -- a fixed bimolecular (order-2) concentration-based
    // rate constant, same dimension a Reac's own Kf gets at order 2.
    if (key === 'concK1') return { kind: 'rate', order: 2 };
    // k1/k2's own true units are #^-1.time^-1 (see describe_enz's own
    // comment on why they're never concentration-scaled) -- only their
    // time part is converted here, same simplification numKf/numKb's "#"
    // portion already gets. kcat (k3) is a plain unimolecular rate, no
    // "#" term at all either way.
    if (key === 'kcat' || key === 'k1' || key === 'k2') return 'timerate';
  }
  return null;
}

function toDisplayValue(node, key, rawValue, units) {
  const kind = fieldKind(node, key);
  if (kind === null || rawValue === undefined || rawValue === null) return rawValue;
  if (kind === 'conc') return concUnitConv.toDisplay(rawValue, units.concUnit);
  if (kind === 'volume') return volumeUnitConv.toDisplay(rawValue, units.volumeUnit);
  if (kind === 'length') return lengthUnitConv.toDisplay(rawValue, units.lengthUnit);
  if (kind === 'time') return timeUnitConv.toDisplay(rawValue, units.timeUnit);
  if (kind === 'diffConst') return diffConstToDisplay(rawValue, units.lengthUnit, units.timeUnit);
  if (kind === 'motorConst') return motorConstToDisplay(rawValue, units.lengthUnit, units.timeUnit);
  if (kind === 'permeability') return permeabilityToDisplay(rawValue, units.concUnit, units.timeUnit);
  if (kind === 'flux') return timeRateToDisplay(rawValue, units.timeUnit);
  if (kind === 'timerate' || kind.kind === 'numrate') return timeRateToDisplay(rawValue, units.timeUnit);
  if (kind.kind === 'rate') return rateConstantToDisplay(rawValue, kind.order, units.concUnit, units.timeUnit);
  return rawValue;
}

function toNativeValue(node, key, displayValue, units) {
  const kind = fieldKind(node, key);
  if (kind === null || !Number.isFinite(displayValue)) return displayValue;
  if (kind === 'conc') return concUnitConv.toNative(displayValue, units.concUnit);
  if (kind === 'volume') return volumeUnitConv.toNative(displayValue, units.volumeUnit);
  if (kind === 'length') return lengthUnitConv.toNative(displayValue, units.lengthUnit);
  if (kind === 'time') return timeUnitConv.toNative(displayValue, units.timeUnit);
  if (kind === 'diffConst') return diffConstToNative(displayValue, units.lengthUnit, units.timeUnit);
  if (kind === 'motorConst') return motorConstToNative(displayValue, units.lengthUnit, units.timeUnit);
  if (kind === 'permeability') return permeabilityToNative(displayValue, units.concUnit, units.timeUnit);
  if (kind === 'flux') return timeRateToNative(displayValue, units.timeUnit);
  if (kind === 'timerate' || kind.kind === 'numrate') return timeRateToNative(displayValue, units.timeUnit);
  if (kind.kind === 'rate') return rateConstantToNative(displayValue, kind.order, units.concUnit, units.timeUnit);
  return displayValue;
}

// The unit suffix a field's label shows (e.g. "concInit (uM)") -- derived
// from fieldKind + whatever's currently selected, replacing what used to
// be a hardcoded label the backend sent (describe_pool's own concUnit,
// etc. -- removed once this moved here, see moose_graph.py's matching
// comment).
function unitSuffixFor(node, key, units) {
  const kind = fieldKind(node, key);
  if (kind === null) return null;
  if (kind === 'conc') return units.concUnit;
  if (kind === 'volume') return units.volumeUnit;
  if (kind === 'length') return units.lengthUnit;
  if (kind === 'time') return timeUnitAbbrev(units.timeUnit);
  if (kind === 'diffConst') return diffConstUnitLabel(units.lengthUnit, units.timeUnit);
  if (kind === 'motorConst') return motorConstUnitLabel(units.lengthUnit, units.timeUnit);
  if (kind === 'permeability') return permeabilityUnitLabel(units.concUnit, units.timeUnit);
  if (kind === 'flux') return fluxUnitLabel(units.timeUnit);
  if (kind === 'timerate') return timeRateUnitLabel(units.timeUnit);
  if (kind.kind === 'numrate') return numRateUnitLabel(kind.order, units.timeUnit);
  if (kind.kind === 'rate') return rateConstantUnitLabel(kind.order, units.concUnit, units.timeUnit);
  return null;
}

// Display-only rounding -- fields are edited as plain strings (see
// initialFieldsFor/handleSave) so this never fights the user mid-keystroke;
// it only ever formats a value that came from the backend.
function formatNumber(value) {
  if (value === undefined || value === null || Number.isNaN(value)) return '';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs < 1e-3 || abs >= 1e6) return value.toExponential(4);
  return String(Number(value.toPrecision(5)));
}

// Rows of fields shown in Properties, grouped by meaning and in on-screen
// order -- e.g. n/nInit together, conc/concInit together. A key listed in
// the matching READONLY_KEYS set renders greyed/read-only within its row;
// every other key in a row is editable.
const ROWS = {
  pool: [
    ['n', 'nInit'],
    ['conc', 'concInit'],
    ['diffConst', 'motorConst'],
  ],
  reac: [
    ['numKf', 'numKb'],
    ['Kf', 'Kb'],
    // kd's own displayed name switches between "Kd" and "Keq" depending on
    // reaction order (see fieldLabel/describe_reac's kdLabel) -- ported
    // from xreac.g's do_update_reac_scaling.
    ['kd', 'tau'],
  ],
  // diameter is a derived, invertible convenience for volume (kkit's
  // classic sphere-equivalent convention), not a real CubeMesh field --
  // editing either one updates the other.
  compartment: [['volume', 'diameter']],
  concchan: [['permeability'], ['numChan', 'flux']],
};

const READONLY_KEYS = {
  reac: new Set(['kd', 'tau']),
  concchan: new Set(['numChan', 'flux']),
};

// Km/kcat (the more familiar Michaelis-Menten-style pair) shown right under
// the parent name; K1 (concK1, k1's own concentration-based counterpart)
// and ratio next; numK1/numK2 (the molecule-count "number units" rate
// constants) last -- the user's own preferred ordering. k3 is never shown
// separately, since it's literally the same MOOSE field as kcat (see
// describe_enz's own comment). Editing Km or kcat here relies entirely on
// MOOSE's own setters (Enz::vSetKm/vSetKcat) to preserve whichever of
// {ratio, Km} it isn't touching -- no extra app-level math needed.
const ENZ_ROWS = {
  'explicit-complex': [['Km', 'kcat'], ['concK1', 'ratio'], ['k1', 'k2']],
  'michaelis-menten': [['Km', 'kcat']],
};

// ratio (k2/kcat) is a native MOOSE field, technically settable, but shown
// read-only/greyed by design -- editing Km or kcat already preserves it
// automatically, so there's no independent reason to expose it as editable.
const ENZ_READONLY_KEYS = {
  'explicit-complex': new Set(['ratio']),
  'michaelis-menten': new Set(),
};

// Explanatory tooltips for fields whose meaning isn't self-evident from the
// label alone -- only the explicit-complex Enz's own quintet needs this.
function fieldTooltip(node, key) {
  if (node.type !== 'enz' || node.data.mechanism !== 'explicit-complex') return '';
  if (key === 'k1' || key === 'k2') return 'Molecule-count ("number units") rate constant, not concentration-based.';
  if (key === 'concK1') return "k1's own concentration-based counterpart (same reaction, converted through the compartment volume).";
  if (key === 'kcat') return 'Same underlying value as k3 -- editing it rescales k2 to preserve the ratio below, and Km to stay fixed.';
  if (key === 'Km') return 'Editing this preserves ratio and kcat, and recomputes concK1/k1 to match.';
  if (key === 'ratio') return 'k2/kcat -- preserved automatically whenever Km or kcat is edited, not independently editable here.';
  return '';
}

function rowsFor(node) {
  if (node.type === 'enz') return ENZ_ROWS[node.data.mechanism] || [];
  return ROWS[node.type] || [];
}

function readOnlyKeysFor(node) {
  if (node.type === 'enz') return ENZ_READONLY_KEYS[node.data.mechanism] || new Set();
  return READONLY_KEYS[node.type] || new Set();
}

// Flat list of this node's own editable numeric keys -- row grouping/order
// doesn't matter here, just membership, since this only seeds/parses
// `fields` (see initialFieldsFor/buildPayload); the on-screen row order
// comes from rowsFor instead.
function editableRowsFor(node) {
  const readOnly = readOnlyKeysFor(node);
  return rowsFor(node)
    .map((row) => row.filter((key) => !readOnly.has(key)))
    .filter((row) => row.length);
}

function initialFieldsFor(node, units) {
  const fields = { name: node.data.name, color: node.data.color, notes: node.data.notes };
  editableRowsFor(node)
    .flat()
    .forEach((key) => {
      fields[key] = formatNumber(toDisplayValue(node, key, node.data[key], units));
    });
  if (node.type === 'pool') fields.isBuffered = !!node.data.isBuffered;
  // expr is free text (a muParser-style expression, function of t or of
  // its own pool inputs), not a number -- kept as a plain string rather
  // than run through formatNumber/parseFloat the way every other
  // editable field is. A summation function's own expr is never shown
  // here at all -- it's always exactly "x0+x1+...", auto-maintained by
  // add_edge's own funcInput handling, never user-typed (see its own
  // read-only display below instead).
  if (node.type === 'stim' || node.type === 'genfunc') fields.expr = node.data.expr ?? '';
  if (node.type === 'genfunc') fields.numInputs = String(node.data.numInputs ?? 0);
  // Which of the target pool's own fields this drives -- conc/concInit
  // (mM) or n/nInit (# of molecules), see the Controls Field toggle below.
  if (node.type === 'stim' || node.type === 'func' || node.type === 'genfunc') fields.field = node.data.field || 'conc';
  fields.flipped = !!node.data.flipped;
  if (node.data.type === 'group' || node.data.type === 'compartment') {
    fields.collapsed = !!node.data.collapsed;
  }
  return fields;
}

// A field's display label, including its unit where one applies (see
// fieldKind/unitSuffixFor -- e.g. "concInit (uM)", "Kf (uM^-1.s^-1)",
// both now computed from whatever's currently selected in the Units
// menu, not a value the backend sends). A field can also override its
// own displayed *name*, not just its unit, the way Reac's own kd
// switches between "Kd" and "Keq" depending on reaction order.
function fieldLabel(node, key, units) {
  const name = node.data[`${key}Label`] || key;
  const unit = unitSuffixFor(node, key, units);
  return unit ? `${name} (${unit})` : name;
}

// Shared by the explicit Save button and the auto-flush-on-unmap effect
// below -- the editable numeric rows are typed as plain strings (see
// initialFieldsFor) and need parsing back to numbers; everything else in
// `fields` (name, notes, isBuffered, expr, ...) already round-trips as-is.
function buildPayload(node, fields, units) {
  const parsed = { ...fields };
  editableRowsFor(node)
    .flat()
    .forEach((key) => {
      parsed[key] = toNativeValue(node, key, parseFloat(fields[key]), units);
    });
  // A whole number of input slots, not a rate/concentration field
  // (editableRowsFor's own numeric rows), so it's parsed separately here.
  if (node.type === 'genfunc') parsed.numInputs = parseInt(fields.numInputs, 10);
  return parsed;
}

function titleFor(node) {
  if (node.type === 'pool') return 'Pool';
  if (node.type === 'reac') return 'Reaction';
  if (node.data.type === 'group') return 'Group';
  if (node.type === 'compartment') return 'Compartment';
  if (node.type === 'concchan') return 'Concentration Channel';
  if (node.type === 'stim') return 'Stimulus';
  if (node.type === 'func') return 'Summation Function';
  if (node.type === 'genfunc') return 'General Function';
  return `Enzyme (${node.data.mechanism})`;
}

export default function PropertiesMenuBox({
  node,
  parentName,
  onSave,
  onToggleFlip,
  onToggleCollapse,
  onAutoLayoutGroup,
  onAutoLayoutGroupByFlow,
  onAutoLayoutRecursive,
  onAutoLayoutRecursiveFlow,
  onClearLayoutLocks,
  layoutRunning,
  layoutProgress,
  selectedGroupScore,
  onUndoLayout,
  canUndoLayout,
  timeUnit,
  concUnit,
  volumeUnit,
  lengthUnit,
}) {
  const units = { timeUnit, concUnit, volumeUnit, lengthUnit };
  const [fields, setFields] = useState(null);
  // Tracks whether `fields` has any edit not yet sent to the backend --
  // set by setField, cleared on every explicit Save and whenever a fresh
  // node is selected. Read from a ref (not state) purely so the flush
  // effect below can see its *latest* value from inside a cleanup closure
  // without needing to depend on (and so re-run for) every keystroke.
  const dirtyRef = useRef(false);
  // Mirrors `fields`/`onSave`/`units` into refs for the same reason: the
  // flush effect's cleanup only ever depends on `node`, so without this it
  // would see stale values from whenever that node was first selected,
  // not whatever was last typed/currently selected in the Units menu.
  const latestRef = useRef({ fields, onSave, units });
  latestRef.current = { fields, onSave, units };

  // Deliberately depends on [node] only, not `units` -- the user's own
  // explicit spec: switching units isn't live, a Properties panel only
  // recomputes its displayed values (via this same effect) when it next
  // becomes visible for some node, i.e. exactly when this effect's own
  // dependency (`node`) changes because a different one just got
  // selected, or this whole panel just (re)mounted. `units` is still read
  // directly below (the current render's own prop value, always fresh
  // for whichever node this effect is actually firing for).
  useEffect(() => {
    setFields(node ? initialFieldsFor(node, units) : null);
    dirtyRef.current = false;
    // The dialog "unmapping" -- either a different node gets selected
    // while Properties is showing, or the whole panel is left (switching
    // to another menu tab unmounts it) -- flushes any edit still sitting
    // in `fields` that never went through an explicit Save click, rather
    // than silently discarding it. Runs for *this* node (the one about to
    // stop being shown), captured directly from this effect's own closure.
    return () => {
      if (dirtyRef.current && node) {
        latestRef.current.onSave(node.id, buildPayload(node, latestRef.current.fields, latestRef.current.units));
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node]);

  if (!node || !fields) {
    return (
      <Box sx={{ p: 2, background: '#f5f5f5', borderRadius: 2, height: '100%' }}>
        <Typography color="text.secondary">
          Click a pool, reaction, enzyme, channel, stimulus, group, or compartment in the diagram to edit its properties.
        </Typography>
      </Box>
    );
  }

  const setField = (key, value) => {
    dirtyRef.current = true;
    setFields((f) => ({ ...f, [key]: value }));
  };

  const handleSave = () => {
    dirtyRef.current = false;
    onSave(node.id, buildPayload(node, fields, units));
  };

  // The user's own later request: Enter should do what clicking Save
  // does, in every field here. Excludes a multiline field's own textarea
  // (Notes, and a stim/func's own expression) -- Enter there still means
  // "new line," matching every other multiline text box's own behavior,
  // not a save-and-dismiss.
  const handleFormKeyDown = (event) => {
    if (event.key !== 'Enter' || event.target.tagName === 'TEXTAREA') return;
    event.preventDefault();
    handleSave();
  };

  return (
    <Box sx={{ p: 2, background: '#f5f5f5', borderRadius: 2, height: '100%', overflowY: 'auto' }} onKeyDown={handleFormKeyDown}>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: node.data.locked ? 0.5 : 2, display: 'flex', alignItems: 'center', gap: 1 }}>
        {titleFor(node)}
        {node.data.locked && (
          <Chip
            label="Position/orientation locked"
            size="small"
            color="warning"
            variant="outlined"
            title="Set automatically by a manual drag, resize, or flip toggle -- auto-layout skips this node until the lock is cleared (see the group-level 'Clear layout locks' button)."
          />
        )}
      </Typography>

      <Grid container spacing={1.5}>
        <Grid size={12}>
          <TextField
            fullWidth
            label="Name"
            size="small"
            value={fields.name}
            onChange={(e) => setField('name', e.target.value)}
          />
        </Grid>
        <Grid size={12}>
          <Tooltip title="Names repeat across a model -- this disambiguates which one you're looking at.">
            <TextField
              fullWidth
              label="Parent"
              size="small"
              value={parentName ?? '(top level)'}
              slotProps={{ input: { readOnly: true } }}
              variant="filled"
            />
          </Tooltip>
        </Grid>

        {rowsFor(node).map((row, i) => {
          const readOnly = readOnlyKeysFor(node);
          return (
            <Grid key={`row-${i}`} size={12} container spacing={1.5}>
              {row.map((key) => (
                <Grid key={key} size={12 / row.length}>
                  <Tooltip title={fieldTooltip(node, key)}>
                    {readOnly.has(key) ? (
                      <TextField
                        fullWidth
                        label={fieldLabel(node, key, units)}
                        size="small"
                        value={formatNumber(toDisplayValue(node, key, node.data[key], units))}
                        slotProps={{ input: { readOnly: true } }}
                        variant="filled"
                      />
                    ) : (
                      <TextField
                        fullWidth
                        label={fieldLabel(node, key, units)}
                        type="number"
                        size="small"
                        value={fields[key]}
                        onChange={(e) => setField(key, e.target.value)}
                      />
                    )}
                  </Tooltip>
                </Grid>
              ))}
            </Grid>
          );
        })}

        {(node.type === 'stim' || node.type === 'func' || node.type === 'genfunc') && (
          <>
            {node.type === 'func' ? (
              // A summation function's own expr is always exactly
              // "x0+x1+..." -- auto-maintained by add_edge's own
              // funcInput handling every time an input is connected or
              // removed, never user-typed (the user's own later request:
              // "no function because that is predefined as a summation").
              <Grid size={12}>
                <Tooltip title="Always the sum of its own connected pool inputs -- drag a connection from another pool onto it to add one.">
                  <TextField
                    fullWidth
                    label="Expression"
                    size="small"
                    value={node.data.expr || ''}
                    slotProps={{ input: { readOnly: true } }}
                    variant="filled"
                  />
                </Tooltip>
              </Grid>
            ) : (
              <Grid size={12}>
                <Tooltip
                  title={
                    node.type === 'genfunc'
                      ? 'x0, x1, ... are read in whichever units Controls Field below is set to (mM or # of molecules).'
                      : "Checked for negative values across the Run panel's runtime before it's saved."
                  }
                >
                  <TextField
                    fullWidth
                    label={node.type === 'genfunc' ? 'Expression (t in seconds, x0, x1 from other pools)' : 'Expression (function of t, in seconds)'}
                    size="small"
                    multiline
                    minRows={2}
                    value={fields.expr}
                    onChange={(e) => setField('expr', e.target.value)}
                  />
                </Tooltip>
              </Grid>
            )}
            {node.type === 'genfunc' && (
              <Grid size={12}>
                <Tooltip title="Referred to in the expression above as x0, x1, ... in the order you connect pools to it.">
                  <TextField
                    fullWidth
                    type="number"
                    label="Number of inputs"
                    size="small"
                    value={fields.numInputs}
                    onChange={(e) => setField('numInputs', e.target.value)}
                    slotProps={{ htmlInput: { min: 0 } }}
                  />
                </Tooltip>
              </Grid>
            )}
            <Grid size={12}>
              <Typography variant="caption" color="text.secondary">
                Controls field
              </Typography>
              <ToggleButtonGroup
                fullWidth
                size="small"
                exclusive
                value={fields.field.startsWith('n') ? 'n' : 'conc'}
                onChange={(e, v) => {
                  if (v === null) return;
                  const isInit = fields.field.endsWith('Init');
                  setField('field', v === 'n' ? (isInit ? 'nInit' : 'n') : isInit ? 'concInit' : 'conc');
                }}
                sx={TOGGLE_GROUP_SX}
              >
                <ToggleButton
                  value="conc"
                  title="Drives the target pool's own concentration field, in mM. Init vs non-Init still follows whether the target pool is buffered; only the domain (mM vs #) is chosen here."
                >
                  {fields.field.endsWith('Init') ? 'concInit' : 'conc'} in mM
                </ToggleButton>
                <ToggleButton
                  value="n"
                  title="Drives the target pool's own molecule-count field directly, in # of molecules. Init vs non-Init still follows whether the target pool is buffered; only the domain (mM vs #) is chosen here."
                >
                  {fields.field.endsWith('Init') ? 'nInit' : 'n'} in # of molecules
                </ToggleButton>
              </ToggleButtonGroup>
            </Grid>
          </>
        )}

        {node.type === 'pool' && (
          <Grid size={12}>
            <FormControlLabel
              control={
                <Checkbox
                  checked={!!fields.isBuffered}
                  onChange={(e) => setField('isBuffered', e.target.checked)}
                />
              }
              label="Buffered (fixed concentration)"
            />
          </Grid>
        )}

        <Grid size={12}>
          <Typography variant="caption" color="text.secondary">
            Color
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
            {[...RAINBOW_16, ...GRAYSCALE_8].map((c) => (
              <Box
                key={c}
                onClick={() => {
                  // Applies immediately (like flip), rather than waiting
                  // for the Save button -- a color pick is a single
                  // discrete action, not something typed incrementally, so
                  // there's no keystroke-storm concern the way a live
                  // rename would have.
                  setField('color', c);
                  onSave(node.id, { color: c });
                }}
                sx={{
                  width: 24,
                  height: 24,
                  borderRadius: '4px',
                  cursor: 'pointer',
                  background: c,
                  boxSizing: 'border-box',
                  border: fields.color === c ? '3px solid #000' : '1px solid #999',
                }}
              />
            ))}
          </Box>
        </Grid>
        <Grid size={12}>
          <TextField
            fullWidth
            label="Notes"
            size="small"
            multiline
            minRows={2}
            value={fields.notes}
            onChange={(e) => setField('notes', e.target.value)}
          />
        </Grid>

        {(node.data.type === 'group' || node.data.type === 'compartment') && (
          <Grid size={12}>
            <FormControlLabel
              control={
                <Checkbox
                  checked={fields.collapsed}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setField('collapsed', checked);
                    onToggleCollapse(node.id, checked);
                  }}
                />
              }
              label="Collapsed (hide contents, show as a single icon)"
            />
          </Grid>
        )}

        {(node.data.type === 'group' || node.data.type === 'compartment') && (
          <Grid size={12} container spacing={1}>
            <Grid size={12}>
              <Typography variant="overline" color="text.secondary">
                Layout
              </Typography>
            </Grid>
            {layoutProgress && (
              // Only Recurse Square/Flow ever set this (see App.jsx's own
              // onAutoLayoutRecursive/onAutoLayoutRecursiveFlow) -- a
              // plain single-level Square/Flow click finishes fast enough
              // that showing a bar for it would just flicker.
              <Grid size={12}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <LinearProgress
                    variant="determinate"
                    value={(layoutProgress.done / layoutProgress.total) * 100}
                    sx={{ flexGrow: 1 }}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {layoutProgress.done}/{layoutProgress.total}
                  </Typography>
                </Box>
              </Grid>
            )}
            {selectedGroupScore && (
              <Grid size={12}>
                <Tooltip title="Lower is better -- weighted total of connector length, crossings, icon overlaps, and footprint area. Same score auto-layout itself uses to judge a candidate.">
                  <TextField
                    fullWidth
                    label="Layout score"
                    size="small"
                    value={formatNumber(selectedGroupScore.weighted)}
                    slotProps={{ input: { readOnly: true } }}
                    variant="filled"
                  />
                </Tooltip>
              </Grid>
            )}
            <Grid size={3}>
              <Button
                fullWidth
                size="small"
                variant="outlined"
                disabled={layoutRunning}
                onClick={() => onAutoLayoutGroup(node.id)}
                title="Packs direct children into a compact grid, alternating pool and non-pool rows (like Flow), refined against connector length/crossings/overlap/area -- discards the result and leaves the group unchanged if it wouldn't actually improve on the current layout."
              >
                Square
              </Button>
            </Grid>
            <Grid size={3}>
              <Button
                fullWidth
                size="small"
                variant="outlined"
                disabled={layoutRunning}
                onClick={() => onAutoLayoutGroup(node.id, { force: true })}
                title="Same as Square, but always applies the freshly-packed result even if it scores worse than the current layout on the connector-length/crossings/overlap/area metric."
              >
                Force Square
              </Button>
            </Grid>
            <Grid size={3}>
              <Button
                fullWidth
                size="small"
                variant="outlined"
                disabled={layoutRunning}
                onClick={() => onAutoLayoutGroup(node.id, { randomizeItems: true })}
                title="Same as Square, but starts the search from a random initial placement (still respecting pool/non-pool rows) instead of the usual flow/name-based ordering -- useful for escaping a local optimum a deterministic start keeps landing in."
              >
                Rand Square
              </Button>
            </Grid>
            <Grid size={3}>
              <Button
                fullWidth
                size="small"
                variant="outlined"
                disabled={layoutRunning}
                onClick={() => onAutoLayoutRecursive(node.id)}
                title="Same as Square, but bottom-up through every nested group's own contents first, then this one -- everything below it rearranges, not just its own direct children."
              >
                Recurse Square
              </Button>
            </Grid>
            <Grid size={3}>
              <Button
                fullWidth
                size="small"
                variant="outlined"
                disabled={layoutRunning}
                onClick={() => onAutoLayoutGroupByFlow(node.id)}
                title="Arranges direct children top-to-bottom by information flow instead of by connector length -- inputs near the top, downstream targets near the bottom, with pools and reactions/enzymes/channels alternating rows (they only ever connect to each other, never their own kind). Discards the result and leaves the group unchanged if it wouldn't actually improve on the current layout. A locked child is left exactly where it is and excluded from the flow order -- lock a molecule to pin its own tier by hand."
              >
                Flow
              </Button>
            </Grid>
            <Grid size={3}>
              <Button
                fullWidth
                size="small"
                variant="outlined"
                disabled={layoutRunning}
                onClick={() => onAutoLayoutGroupByFlow(node.id, { force: true })}
                title="Same as Flow, but always applies the result even if it scores worse than the current layout on the plain connector-length/crossings/overlap/area metric -- a cramped Square packing can score deceptively well on that metric purely by being cramped, which can otherwise block Flow's own alternating, more readable structure from ever being applied."
              >
                Force Flow
              </Button>
            </Grid>
            <Grid size={3}>
              <Button
                fullWidth
                size="small"
                variant="outlined"
                disabled={layoutRunning}
                onClick={() => onAutoLayoutGroupByFlow(node.id, { randomizeItems: true, randomizeBlanks: true })}
                title="Same as Flow, but starts from a random initial placement -- items AND each row's own blank slot are shuffled, not just item order -- instead of the usual flow-ordered start."
              >
                Rand Flow
              </Button>
            </Grid>
            <Grid size={3}>
              <Button
                fullWidth
                size="small"
                variant="outlined"
                disabled={layoutRunning}
                onClick={() => onAutoLayoutRecursiveFlow(node.id)}
                title="Bottom-up: every nested group gets its own Flow layout first, then this group's own direct children -- which must all be groups/compartments themselves, or this refuses -- are arranged as a plain square array (a group is neither a pool nor a non-pool, so no row alternation applies at this level)."
              >
                Recurse Flow
              </Button>
            </Grid>
            <Grid size={6}>
              <Button
                fullWidth
                size="small"
                variant="outlined"
                disabled={!canUndoLayout || layoutRunning}
                onClick={onUndoLayout}
                title="Reverts whatever the last auto-layout action (on this group or any other) just changed -- only the most recent run can be undone."
              >
                Undo Layout
              </Button>
            </Grid>
            <Grid size={6}>
              <Button
                fullWidth
                size="small"
                variant="outlined"
                color="warning"
                disabled={layoutRunning}
                onClick={() => onClearLayoutLocks(node.id)}
                title="Clears the 'manually positioned/oriented' flag on this group and everything inside it -- a manual drag, resize, or flip toggle sets that flag automatically so auto-layout leaves it alone; use this if you actually want auto-layout to touch everything here again."
              >
                Unlock Placed Items
              </Button>
            </Grid>
          </Grid>
        )}

        {!['group', 'compartment', 'stim'].includes(node.data.type) && (
          <Grid size={12}>
            <FormControlLabel
              control={
                <Checkbox
                  checked={fields.flipped}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setField('flipped', checked);
                    onToggleFlip(node.id, checked);
                  }}
                />
              }
              label={
                node.type === 'pool'
                  ? 'Flip orientation (swap left/right connection sides)'
                  : node.type === 'concchan'
                  ? 'Flip orientation (swap influx/efflux sides)'
                  : 'Flip orientation (swap substrate/product sides)'
              }
            />
          </Grid>
        )}

        <Grid size={12}>
          <Divider sx={{ my: 1 }} />
          <Button fullWidth variant="contained" onClick={handleSave}>
            Save
          </Button>
        </Grid>
      </Grid>
    </Box>
  );
}
