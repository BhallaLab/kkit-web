import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormControlLabel,
  Checkbox,
  Button,
  Stack,
} from '@mui/material';

const NUMERIC_FIELDS = [
  { key: 'n', label: 'n (molecule count)' },
  { key: 'nInit', label: 'nInit' },
  { key: 'conc', label: 'conc (mM)' },
  { key: 'concInit', label: 'concInit (mM)' },
  { key: 'diffConst', label: 'Diffusion const' },
];

export default function PoolEditDialog({ node, onClose, onSave }) {
  const [fields, setFields] = useState(null);

  useEffect(() => {
    if (node) {
      setFields({
        n: node.data.n,
        nInit: node.data.nInit,
        conc: node.data.conc,
        concInit: node.data.concInit,
        diffConst: node.data.diffConst,
        isBuffered: node.data.isBuffered,
        color: node.data.color,
        notes: node.data.notes,
      });
    }
  }, [node]);

  if (!node || !fields) return null;

  const setField = (key, value) => setFields((f) => ({ ...f, [key]: value }));

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Pool: {node.data.name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {NUMERIC_FIELDS.map(({ key, label }) => (
            <TextField
              key={key}
              label={label}
              type="number"
              size="small"
              value={fields[key]}
              onChange={(e) => setField(key, parseFloat(e.target.value))}
            />
          ))}
          <FormControlLabel
            control={
              <Checkbox
                checked={!!fields.isBuffered}
                onChange={(e) => setField('isBuffered', e.target.checked)}
              />
            }
            label="Buffered (fixed concentration)"
          />
          <TextField
            label="Color"
            size="small"
            value={fields.color}
            onChange={(e) => setField('color', e.target.value)}
          />
          <TextField
            label="Notes"
            size="small"
            multiline
            minRows={2}
            value={fields.notes}
            onChange={(e) => setField('notes', e.target.value)}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => onSave(node.id, fields)}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
