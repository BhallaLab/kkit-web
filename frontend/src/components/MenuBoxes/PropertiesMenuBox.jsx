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
} from '@mui/material';
import { RAINBOW_16 } from '../../colorUtils';

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

// Rows of editable numeric fields, grouped by meaning rather than listed
// flat -- e.g. n/nInit together, conc/concInit together.
const EDITABLE_ROWS = {
  pool: [
    ['n', 'nInit'],
    ['conc', 'concInit'],
    ['diffConst', 'motorConst'],
  ],
  reac: [
    ['numKf', 'numKb'],
    ['Kf', 'Kb'],
  ],
  // diameter is a derived, invertible convenience for volume (kkit's
  // classic sphere-equivalent convention), not a real CubeMesh field --
  // editing either one updates the other.
  compartment: [['volume', 'diameter']],
  concchan: [['permeability']],
};

const READONLY_ROWS = {
  // kd's own displayed name switches between "Kd" and "Keq" depending on
  // reaction order (see fieldLabel/describe_reac's kdLabel) -- ported
  // from xreac.g's do_update_reac_scaling.
  reac: [['kd', 'tau']],
  concchan: [['numChan', 'flux']],
};

const ENZ_EDITABLE_ROWS = {
  'explicit-complex': [['k1', 'k2', 'k3']],
  'michaelis-menten': [['Km', 'kcat']],
};

// Km/kcat/ratio are native MOOSE fields on an explicit-complex Enz too, but
// MOOSE derives them from k1/k2/k3 (confirmed not independently settable) --
// shown read-only rather than omitted, since they're genuinely informative.
const ENZ_READONLY_ROWS = {
  'explicit-complex': [['Km', 'kcat', 'ratio']],
  'michaelis-menten': [],
};

function editableRowsFor(node) {
  if (node.type === 'enz') return ENZ_EDITABLE_ROWS[node.data.mechanism];
  return EDITABLE_ROWS[node.type] || [];
}

function readOnlyRowsFor(node) {
  if (node.type === 'enz') return ENZ_READONLY_ROWS[node.data.mechanism];
  return READONLY_ROWS[node.type] || [];
}

function initialFieldsFor(node) {
  const fields = { name: node.data.name, color: node.data.color, notes: node.data.notes };
  editableRowsFor(node)
    .flat()
    .forEach((key) => {
      fields[key] = formatNumber(node.data[key]);
    });
  if (node.type === 'pool') fields.isBuffered = !!node.data.isBuffered;
  // expr is free text (a muParser-style expression, function of t), not a
  // number -- kept as a plain string rather than run through
  // formatNumber/parseFloat the way every other editable field is.
  if (node.type === 'stim') fields.expr = node.data.expr ?? '';
  fields.flipped = !!node.data.flipped;
  if (node.data.type === 'group' || node.data.type === 'compartment') {
    fields.collapsed = !!node.data.collapsed;
  }
  return fields;
}

// A field's display label, including its unit where the backend provides
// one (see moose_graph.py's describe_pool/describe_reac/describe_enz --
// e.g. "concInit (µM)", "Kf (µM^-1.s^-1)"). A field can also
// override its own displayed *name*, not just its unit, the way Reac's
// own kd switches between "Kd" and "Keq" depending on reaction order.
function fieldLabel(node, key) {
  const name = node.data[`${key}Label`] || key;
  const unit = node.data[`${key}Unit`];
  return unit ? `${name} (${unit})` : name;
}

// Shared by the explicit Save button and the auto-flush-on-unmap effect
// below -- the editable numeric rows are typed as plain strings (see
// initialFieldsFor) and need parsing back to numbers; everything else in
// `fields` (name, notes, isBuffered, expr, ...) already round-trips as-is.
function buildPayload(node, fields) {
  const parsed = { ...fields };
  editableRowsFor(node)
    .flat()
    .forEach((key) => {
      parsed[key] = parseFloat(fields[key]);
    });
  return parsed;
}

function titleFor(node) {
  if (node.type === 'pool') return 'Pool';
  if (node.type === 'reac') return 'Reaction';
  if (node.data.type === 'group') return 'Group';
  if (node.type === 'compartment') return 'Compartment';
  if (node.type === 'concchan') return 'Concentration Channel';
  if (node.type === 'stim') return 'Stimulus';
  return `Enzyme (${node.data.mechanism})`;
}

export default function PropertiesMenuBox({
  node,
  parentName,
  onSave,
  onToggleFlip,
  onToggleCollapse,
  onAutoLayoutGroup,
  onAutoLayoutRecursive,
  onClearLayoutLocks,
}) {
  const [fields, setFields] = useState(null);
  // Tracks whether `fields` has any edit not yet sent to the backend --
  // set by setField, cleared on every explicit Save and whenever a fresh
  // node is selected. Read from a ref (not state) purely so the flush
  // effect below can see its *latest* value from inside a cleanup closure
  // without needing to depend on (and so re-run for) every keystroke.
  const dirtyRef = useRef(false);
  // Mirrors `fields`/`onSave` into refs for the same reason: the flush
  // effect's cleanup only ever depends on `node`, so without this it
  // would see the stale `fields`/`onSave` from whenever that node was
  // first selected, not whatever was last typed.
  const latestRef = useRef({ fields, onSave });
  latestRef.current = { fields, onSave };

  useEffect(() => {
    setFields(node ? initialFieldsFor(node) : null);
    dirtyRef.current = false;
    // The dialog "unmapping" -- either a different node gets selected
    // while Properties is showing, or the whole panel is left (switching
    // to another menu tab unmounts it) -- flushes any edit still sitting
    // in `fields` that never went through an explicit Save click, rather
    // than silently discarding it. Runs for *this* node (the one about to
    // stop being shown), captured directly from this effect's own closure.
    return () => {
      if (dirtyRef.current && node) {
        latestRef.current.onSave(node.id, buildPayload(node, latestRef.current.fields));
      }
    };
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
    onSave(node.id, buildPayload(node, fields));
  };

  return (
    <Box sx={{ p: 2, background: '#f5f5f5', borderRadius: 2, height: '100%', overflowY: 'auto' }}>
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
            label="Parent"
            size="small"
            value={parentName ?? '(top level)'}
            slotProps={{ input: { readOnly: true } }}
            variant="filled"
            helperText="Names repeat across a model -- this disambiguates which one you're looking at."
          />
        </Grid>
        <Grid size={12}>
          <TextField
            fullWidth
            label="Name"
            size="small"
            value={fields.name}
            onChange={(e) => setField('name', e.target.value)}
          />
        </Grid>

        {editableRowsFor(node).map((row, i) => (
          <Grid key={`edit-${i}`} size={12} container spacing={1.5}>
            {row.map((key) => (
              <Grid key={key} size={12 / row.length}>
                <TextField
                  fullWidth
                  label={fieldLabel(node, key)}
                  type="number"
                  size="small"
                  value={fields[key]}
                  onChange={(e) => setField(key, e.target.value)}
                />
              </Grid>
            ))}
          </Grid>
        ))}

        {readOnlyRowsFor(node).map((row, i) => (
          <Grid key={`ro-${i}`} size={12} container spacing={1.5}>
            {row.map((key) => (
              <Grid key={key} size={12 / row.length}>
                <TextField
                  fullWidth
                  label={fieldLabel(node, key)}
                  size="small"
                  value={formatNumber(node.data[key])}
                  slotProps={{ input: { readOnly: true } }}
                  variant="filled"
                />
              </Grid>
            ))}
          </Grid>
        ))}

        {node.type === 'stim' && (
          <>
            <Grid size={12}>
              <TextField
                fullWidth
                label="Expression (function of t, in seconds)"
                size="small"
                multiline
                minRows={2}
                value={fields.expr}
                onChange={(e) => setField('expr', e.target.value)}
                helperText="Checked for negative values across the Run panel's runtime before it's saved."
              />
            </Grid>
            <Grid size={12}>
              <TextField
                fullWidth
                label="Drives"
                size="small"
                value={node.data.field || ''}
                slotProps={{ input: { readOnly: true } }}
                variant="filled"
                helperText="conc for a regular pool, concInit for a buffered one -- set automatically from the target pool."
              />
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
            {RAINBOW_16.map((c) => (
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
            <Grid size={6}>
              <Button
                fullWidth
                size="small"
                variant="outlined"
                onClick={() => onAutoLayoutGroup(node.id)}
              >
                Auto-layout direct children
              </Button>
            </Grid>
            <Grid size={6}>
              <Button
                fullWidth
                size="small"
                variant="outlined"
                onClick={() => onAutoLayoutRecursive(node.id)}
                title="Lays out every nested group's own contents first, then this one, bottom-up -- everything below it rearranges, not just its own direct children."
              >
                Auto-layout recursively
              </Button>
            </Grid>
            <Grid size={12}>
              <Button
                fullWidth
                size="small"
                variant="outlined"
                color="warning"
                onClick={() => onClearLayoutLocks(node.id)}
                title="Clears the 'manually positioned/oriented' flag on this group and everything inside it -- a manual drag, resize, or flip toggle sets that flag automatically so auto-layout leaves it alone; use this if you actually want auto-layout to touch everything here again."
              >
                Clear layout locks (this group and everything inside it)
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
