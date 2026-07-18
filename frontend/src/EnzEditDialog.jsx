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

const MECHANISM_FIELDS = {
  'explicit-complex': [
    { key: 'k1', label: 'k1 (binding)' },
    { key: 'k2', label: 'k2 (unbinding)' },
    { key: 'k3', label: 'k3 (catalysis)' },
  ],
  'michaelis-menten': [
    { key: 'Km', label: 'Km' },
    { key: 'kcat', label: 'kcat' },
  ],
};

export default function EnzEditDialog({ node, onClose, onSave }) {
  const [fields, setFields] = useState(null);

  useEffect(() => {
    if (node) {
      const numeric = Object.fromEntries(
        MECHANISM_FIELDS[node.data.mechanism].map(({ key }) => [key, node.data[key]])
      );
      setFields({
        ...numeric,
        color: node.data.color,
        notes: node.data.notes,
        flipped: !!node.data.flipped,
      });
    }
  }, [node]);

  if (!node || !fields) return null;

  const setField = (key, value) => setFields((f) => ({ ...f, [key]: value }));
  const numericFields = MECHANISM_FIELDS[node.data.mechanism];

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        Enzyme: {node.data.name} ({node.data.mechanism})
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {numericFields.map(({ key, label }) => (
            <TextField
              key={key}
              label={label}
              type="number"
              size="small"
              value={fields[key]}
              onChange={(e) => setField(key, parseFloat(e.target.value))}
            />
          ))}
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
          <FormControlLabel
            control={
              <Checkbox
                checked={fields.flipped}
                onChange={(e) => setField('flipped', e.target.checked)}
              />
            }
            label="Flip orientation (swap substrate/product sides)"
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
