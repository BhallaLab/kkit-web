import {
  Box,
  Typography,
  Button,
  Stack,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Alert,
  Divider,
} from '@mui/material';

// All of this panel's own state (the parsed file, the entity mapping, the
// run result) lives in App.jsx, not here -- same reasoning as Dose
// Response (see its own MenuBox): only the currently-selected left menu is
// ever mounted, so a plain local useState would be thrown away on every
// tab switch. The result itself is rendered in the Plots tab (see
// PlotsPanel), not inline here.
export default function FindSimMenuBox({
  parsed,
  entityMap,
  fileName,
  running,
  error,
  result,
  onFile,
  onEntityChange,
  onRun,
}) {
  const blocks = parsed ? [...parsed.stimuli, parsed.readout] : [];
  const allMapped = blocks.length > 0 && blocks.every((b) => entityMap[b.id]);

  return (
    <Box sx={{ p: 2, background: '#f5f5f5', borderRadius: 2, height: '100%', overflowY: 'auto' }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 1.5 }}>
        FindSim Experiment
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        Load a FindSim experiment spec (TimeSeries or DoseResponse -- see
        FindSim-Schema.json's Stimuli/Readouts/Experiment.design) and run it
        against the current model. The result appears in the Plots tab,
        alongside the reference data being reproduced.
      </Typography>

      <Button component="label" variant="outlined" fullWidth disabled={running}>
        {fileName || 'Load experiment .json'}
        <input type="file" accept=".json" hidden onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} />
      </Button>

      {parsed && (
        <>
          <Stack direction="row" spacing={1} sx={{ mt: 1.5, mb: 1 }}>
            <Typography variant="body2">
              <strong>Design:</strong> {parsed.design}
            </Typography>
          </Stack>

          <Typography variant="caption" color="text.secondary">
            Match each experiment entity to a pool in this model
          </Typography>
          <Stack spacing={1} sx={{ mt: 0.5, mb: 1.5 }}>
            {blocks.map((b) => (
              <FormControl key={b.id} fullWidth size="small" disabled={running}>
                <InputLabel>{b.entityName}{b.alias && b.alias !== b.entityName ? ` (${b.alias})` : ''}</InputLabel>
                <Select
                  label={b.entityName}
                  value={entityMap[b.id] || ''}
                  onChange={(e) => onEntityChange(b.id, e.target.value)}
                >
                  {parsed.poolOptions.map((p) => (
                    <MenuItem key={p.id} value={p.id}>
                      {p.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            ))}
          </Stack>

          <Button fullWidth variant="contained" color="success" disabled={running || !allMapped} onClick={onRun}>
            {running ? 'Running…' : 'Run'}
          </Button>
        </>
      )}

      {result && result.score != null && (
        <>
          <Divider sx={{ my: 1.5 }} />
          <Typography variant="body2">
            NRMS score: <strong>{result.score.toFixed(3)}</strong>
          </Typography>
        </>
      )}

      {error && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {error}
        </Alert>
      )}
    </Box>
  );
}
