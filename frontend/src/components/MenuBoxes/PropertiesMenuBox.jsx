import { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  FormControlLabel,
  Checkbox,
  Button,
  Grid,
  Divider,
} from '@mui/material';

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
  return node.type === 'enz' ? ENZ_READONLY_ROWS[node.data.mechanism] : [];
}

function initialFieldsFor(node) {
  const fields = { name: node.data.name, color: node.data.color, notes: node.data.notes };
  editableRowsFor(node)
    .flat()
    .forEach((key) => {
      fields[key] = formatNumber(node.data[key]);
    });
  if (node.type === 'pool') fields.isBuffered = !!node.data.isBuffered;
  if (node.type === 'reac' || node.type === 'enz') fields.flipped = !!node.data.flipped;
  return fields;
}

function titleFor(node) {
  if (node.type === 'pool') return 'Pool';
  if (node.type === 'reac') return 'Reaction';
  return `Enzyme (${node.data.mechanism})`;
}

export default function PropertiesMenuBox({ node, onSave }) {
  const [fields, setFields] = useState(null);

  useEffect(() => {
    setFields(node ? initialFieldsFor(node) : null);
  }, [node]);

  if (!node || !fields) {
    return (
      <Box sx={{ p: 2, background: '#f5f5f5', borderRadius: 2, height: '100%' }}>
        <Typography color="text.secondary">
          Click a pool, reaction, or enzyme in the diagram to edit its properties.
        </Typography>
      </Box>
    );
  }

  const setField = (key, value) => setFields((f) => ({ ...f, [key]: value }));

  const handleSave = () => {
    const parsed = { ...fields };
    editableRowsFor(node)
      .flat()
      .forEach((key) => {
        parsed[key] = parseFloat(fields[key]);
      });
    onSave(node.id, parsed);
  };

  return (
    <Box sx={{ p: 2, background: '#f5f5f5', borderRadius: 2, height: '100%', overflowY: 'auto' }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 2 }}>
        {titleFor(node)}
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

        {editableRowsFor(node).map((row, i) => (
          <Grid key={`edit-${i}`} size={12} container spacing={1.5}>
            {row.map((key) => (
              <Grid key={key} size={12 / row.length}>
                <TextField
                  fullWidth
                  label={key}
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
                  label={key}
                  size="small"
                  value={formatNumber(node.data[key])}
                  slotProps={{ input: { readOnly: true } }}
                  variant="filled"
                />
              </Grid>
            ))}
          </Grid>
        ))}

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
          <TextField
            fullWidth
            label="Color"
            size="small"
            value={fields.color}
            onChange={(e) => setField('color', e.target.value)}
          />
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

        {(node.type === 'reac' || node.type === 'enz') && (
          <Grid size={12}>
            <FormControlLabel
              control={
                <Checkbox
                  checked={fields.flipped}
                  onChange={(e) => setField('flipped', e.target.checked)}
                />
              }
              label="Flip orientation (swap substrate/product sides)"
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
