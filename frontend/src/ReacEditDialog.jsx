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
  { key: 'Kf', label: 'Kf (forward rate)' },
  { key: 'Kb', label: 'Kb (backward rate)' },
];

export default function ReacEditDialog({ node, onClose, onSave }) {
  const [fields, setFields] = useState(null);

  useEffect(() => {
    if (node) {
      setFields({
        Kf: node.data.Kf,
        Kb: node.data.Kb,
        color: node.data.color,
        notes: node.data.notes,
        flipped: !!node.data.flipped,
      });
    }
  }, [node]);

  if (!node || !fields) return null;

  const setField = (key, value) => setFields((f) => ({ ...f, [key]: value }));

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Reaction: {node.data.name}</DialogTitle>
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
