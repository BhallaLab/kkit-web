import {
  Box,
  Typography,
  Button,
  Grid,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  ToggleButtonGroup,
  ToggleButton,
  Alert,
} from '@mui/material';

// Mirrors xdoser.g's own 8 concentration-range toggles -- decade 0 is
// 0.1 nM (1e-7 mM, matching this app's mM-valued concInit), each
// subsequent decade x10 (see sim_runner.py's dose_concentrations, which
// this must stay in step with).
const DECADE_LABELS = ['0.1 nM', '1 nM', '10 nM', '100 nM', '1 µM', '10 µM', '100 µM', '1 mM'];

function poolOptions(nodes) {
  // An enzyme's hidden complex pool is never something you'd dose or
  // monitor directly.
  return nodes.filter((n) => n.type === 'pool' && !n.data.isEnzComplex);
}

// All of this panel's own state (which pools, the range, the toggles, the
// in-progress/completed run) lives in App.jsx, not here -- only the
// currently-selected left menu is ever mounted (see AppLayout's
// menuComponents), so a plain local useState would be thrown away the
// moment the user switched to another tab and back. The resulting curve
// itself is rendered in the Plots tab (see PlotsPanel), not inline here.
export default function DoseResponseMenuBox({ flowGraph, params, setParams, running, error, onStart, onHalt }) {
  const pools = poolOptions(flowGraph.nodes);
  const setField = (key, value) => setParams((p) => ({ ...p, [key]: value }));

  return (
    <Box sx={{ p: 2, background: '#f5f5f5', borderRadius: 2, height: '100%', overflowY: 'auto' }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 1.5 }}>
        Dose Response
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        Steps the variable pool's concentration through a log-spaced range and
        records the monitored pool's steady-state response at each level,
        using the Run panel's runtime to let the system settle. The
        resulting curve appears in the Plots tab.
      </Typography>

      <FormControl fullWidth size="small" sx={{ mb: 1 }} disabled={running}>
        <InputLabel>Variable pool (dose)</InputLabel>
        <Select label="Variable pool (dose)" value={params.inputId} onChange={(e) => setField('inputId', e.target.value)}>
          {pools.map((p) => (
            <MenuItem key={p.id} value={p.id}>
              {p.data.name}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <FormControl fullWidth size="small" sx={{ mb: 1.5 }} disabled={running}>
        <InputLabel>Monitored pool (response)</InputLabel>
        <Select label="Monitored pool (response)" value={params.outputId} onChange={(e) => setField('outputId', e.target.value)}>
          {pools.map((p) => (
            <MenuItem key={p.id} value={p.id}>
              {p.data.name}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <Typography variant="caption" color="text.secondary">
        Concentration range
      </Typography>
      <Grid container spacing={1} sx={{ mt: 0.5, mb: 1.5 }}>
        <Grid size={6}>
          <FormControl fullWidth size="small" disabled={running}>
            <InputLabel>From</InputLabel>
            <Select label="From" value={params.minDecade} onChange={(e) => setField('minDecade', e.target.value)}>
              {DECADE_LABELS.map((l, i) => (
                <MenuItem key={i} value={i}>
                  {l}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Grid>
        <Grid size={6}>
          <FormControl fullWidth size="small" disabled={running}>
            <InputLabel>To</InputLabel>
            <Select label="To" value={params.maxDecade} onChange={(e) => setField('maxDecade', e.target.value)}>
              {DECADE_LABELS.map((l, i) => (
                <MenuItem key={i} value={i}>
                  {l}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Grid>
      </Grid>

      <Grid container spacing={1} sx={{ mb: 1.5 }}>
        <Grid size={6}>
          <ToggleButtonGroup
            fullWidth
            size="small"
            exclusive
            disabled={running}
            value={params.buffered}
            onChange={(e, v) => v !== null && setField('buffered', v)}
          >
            <ToggleButton value title="Free conc is forced to the dose value (a real clamp)">
              Buffered
            </ToggleButton>
            <ToggleButton value={false} title="Each dose is added to the pool's current concentration">
              Incremented
            </ToggleButton>
          </ToggleButtonGroup>
        </Grid>
        <Grid size={6}>
          <ToggleButtonGroup
            fullWidth
            size="small"
            exclusive
            disabled={running}
            value={params.resetEachLevel}
            onChange={(e, v) => v !== null && setField('resetEachLevel', v)}
          >
            <ToggleButton value title="Reinitializes the whole model before each dose level">
              Reset each level
            </ToggleButton>
            <ToggleButton value={false} title="Lets the system evolve continuously from the previous level">
              Continue series
            </ToggleButton>
          </ToggleButtonGroup>
        </Grid>
        <Grid size={6}>
          <ToggleButtonGroup
            fullWidth
            size="small"
            exclusive
            disabled={running}
            value={params.decreasing}
            onChange={(e, v) => v !== null && setField('decreasing', v)}
          >
            <ToggleButton value={false}>Increasing</ToggleButton>
            <ToggleButton value>Decreasing</ToggleButton>
          </ToggleButtonGroup>
        </Grid>
        <Grid size={6}>
          <ToggleButtonGroup
            fullWidth
            size="small"
            exclusive
            disabled={running}
            value={params.fine}
            onChange={(e, v) => v !== null && setField('fine', v)}
          >
            <ToggleButton value={false}>Coarse (3/decade)</ToggleButton>
            <ToggleButton value title="10 points per decade instead of 3">
              Fine (10/decade)
            </ToggleButton>
          </ToggleButtonGroup>
        </Grid>
      </Grid>

      <Grid container spacing={1}>
        <Grid size={running ? 6 : 12}>
          <Button fullWidth variant="contained" color="success" disabled={running} onClick={onStart}>
            Start
          </Button>
        </Grid>
        {running && (
          <Grid size={6}>
            <Button fullWidth variant="contained" color="error" onClick={onHalt}>
              Halt
            </Button>
          </Grid>
        )}
      </Grid>

      {error && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {error}
        </Alert>
      )}
    </Box>
  );
}
