import { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Grid,
  CircularProgress,
  Alert,
  Stack,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Divider,
  Tooltip,
  ToggleButtonGroup,
  ToggleButton,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { time, timeUnitAbbrev } from '../../unitConversions';
import { MUTED_BUTTON_SX, SECTION_HEADER_SX, TOGGLE_GROUP_SX, START_BUTTON_SX, STOP_BUTTON_SX } from '../../menuStyle';

// Same display-rounding convention as PropertiesMenuBox's own formatNumber.
function formatNumber(value) {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs < 1e-3 || abs >= 1e6) return value.toExponential(4);
  return String(Number(value.toPrecision(5)));
}

export default function RunMenuBox({
  onStart,
  onReset,
  isRunning,
  error,
  runtime,
  setRuntime,
  plotDt,
  setPlotDt,
  solverMethod,
  setSolverMethod,
  overlayPlots,
  setOverlayPlots,
  plotDomain,
  setPlotDomain,
  timeUnit,
  findSimParsed,
  findSimEntityMap,
  findSimFileName,
  findSimRunning,
  findSimError,
  findSimResult,
  onFindSimFile,
  onFindSimEntityChange,
  onFindSimRun,
}) {
  // runtime/plotDt themselves stay in native seconds (see App.jsx -- they
  // also feed /api/run/start, dose response's own settle time, and get
  // saved/loaded as-is in the SBML file's runSettings, none of which know
  // about display units at all) -- only *this panel's own* text fields
  // show/accept the currently-selected time unit, converting back to
  // native on every keystroke. Recomputed once when this panel becomes
  // visible (mirrors PropertiesMenuBox's own "not live" convention, see
  // its own matching comment), not on every runtime/plotDt/timeUnit
  // change thereafter.
  const [runtimeText, setRuntimeText] = useState(() => formatNumber(time.toDisplay(parseFloat(runtime) || 0, timeUnit)));
  const [plotDtText, setPlotDtText] = useState(() => formatNumber(time.toDisplay(parseFloat(plotDt) || 0, timeUnit)));
  useEffect(() => {
    setRuntimeText(formatNumber(time.toDisplay(parseFloat(runtime) || 0, timeUnit)));
    setPlotDtText(formatNumber(time.toDisplay(parseFloat(plotDt) || 0, timeUnit)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRuntimeTextChange = (text) => {
    setRuntimeText(text);
    const parsed = parseFloat(text);
    if (Number.isFinite(parsed)) setRuntime(String(time.toNative(parsed, timeUnit)));
  };
  const handlePlotDtTextChange = (text) => {
    setPlotDtText(text);
    const parsed = parseFloat(text);
    if (Number.isFinite(parsed)) setPlotDt(String(time.toNative(parsed, timeUnit)));
  };

  const runtimeNum = parseFloat(runtime);
  const plotDtNum = parseFloat(plotDt);
  const invalid = !(runtimeNum > 0) || !(plotDtNum > 0);
  const abbrev = timeUnitAbbrev(timeUnit);

  const findSimBlocks = findSimParsed ? [...findSimParsed.stimuli, findSimParsed.readout] : [];
  const findSimAllMapped = findSimBlocks.length > 0 && findSimBlocks.every((b) => findSimEntityMap[b.id]);

  return (
    <Box sx={{ p: 2, background: '#f5f5f5', borderRadius: 2, height: '100%', overflowY: 'auto' }}>
      <Typography sx={{ ...SECTION_HEADER_SX, mb: 1 }}>Run simulation</Typography>

      <Grid container spacing={1}>
        <Grid size={6}>
          <Button
            fullWidth
            variant="contained"
            startIcon={isRunning ? <CircularProgress size={16} color="inherit" /> : <PlayArrowIcon fontSize="small" />}
            sx={START_BUTTON_SX}
            disabled={isRunning || invalid}
            onClick={() => onStart(runtimeNum, plotDtNum)}
          >
            {isRunning ? 'Running...' : 'Start'}
          </Button>
        </Grid>
        <Grid size={6}>
          <Button
            fullWidth
            variant="contained"
            startIcon={<RestartAltIcon fontSize="small" />}
            sx={STOP_BUTTON_SX}
            disabled={isRunning}
            onClick={onReset}
          >
            Reset
          </Button>
        </Grid>
      </Grid>

      {/* Runs go to completion synchronously for now (no live/incremental
          streaming or a Stop button yet) -- the panel just blocks and shows
          a spinner until the full time course comes back. */}
      {isRunning && (
        <Alert severity="info" sx={{ mt: 1 }}>
          Simulating {runtimeText}
          {abbrev} of model time -- this request blocks until it finishes.
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}

      <Grid container spacing={1} sx={{ mt: 1, mb: 1 }}>
        <Grid size={6}>
          <TextField
            fullWidth
            size="small"
            label={`Runtime (${abbrev})`}
            type="number"
            value={runtimeText}
            onChange={(e) => handleRuntimeTextChange(e.target.value)}
          />
        </Grid>
        <Grid size={6}>
          <TextField
            fullWidth
            size="small"
            label={`Plot dt (${abbrev})`}
            type="number"
            value={plotDtText}
            onChange={(e) => handlePlotDtTextChange(e.target.value)}
          />
        </Grid>
      </Grid>

      <Divider sx={{ my: 1 }} />

      <Typography sx={{ ...SECTION_HEADER_SX, mb: 0.5 }}>Numerical Method</Typography>
      <ToggleButtonGroup
        fullWidth
        size="small"
        exclusive
        disabled={isRunning}
        value={solverMethod}
        onChange={(e, v) => v !== null && setSolverMethod(v)}
        sx={TOGGLE_GROUP_SX}
      >
        <ToggleButton value="lsoda" title="Deterministic ODE integration (Ksolve/LSODA) -- the usual choice.">
          LSODA: deterministic
        </ToggleButton>
        <ToggleButton value="gssa" title="Gillespie's Stochastic Simulation Algorithm (Gsolve) -- discrete molecule counts, run-to-run noise.">
          GSSA: stochastic
        </ToggleButton>
      </ToggleButtonGroup>

      <Divider sx={{ my: 1 }} />

      <Typography sx={{ ...SECTION_HEADER_SX, mb: 0.5 }}>Plot Control</Typography>
      <Grid container spacing={1}>
        <Grid size={6}>
          <Typography variant="caption" color="text.secondary">
            Overlay plots
          </Typography>
          <ToggleButtonGroup
            fullWidth
            size="small"
            exclusive
            value={overlayPlots}
            onChange={(e, v) => v !== null && setOverlayPlots(v)}
            sx={TOGGLE_GROUP_SX}
          >
            <ToggleButton value={false}>Off</ToggleButton>
            <ToggleButton value title="Keeps the previous run's own trace as a dashed line when a new run's solid trace comes in -- turning this off drops the dashed trace the next time a run completes, not immediately.">
              On
            </ToggleButton>
          </ToggleButtonGroup>
        </Grid>
        <Grid size={6}>
          <Typography variant="caption" color="text.secondary">
            Plot in
          </Typography>
          <ToggleButtonGroup
            fullWidth
            size="small"
            exclusive
            value={plotDomain}
            onChange={(e, v) => v !== null && setPlotDomain(v)}
            sx={TOGGLE_GROUP_SX}
          >
            <ToggleButton value="conc" title="Concentration, in whichever unit the Units menu currently has selected.">
              Conc
            </ToggleButton>
            <ToggleButton value="n" title="Raw molecule count -- never unit-scaled, same as a pool's own n field elsewhere.">
              # molecules
            </ToggleButton>
          </ToggleButtonGroup>
        </Grid>
      </Grid>

      <Divider sx={{ my: 1 }} />

      <Typography sx={{ ...SECTION_HEADER_SX, mb: 1 }}>FindSim Experiment</Typography>

      <Tooltip title="Load a FindSim experiment spec (TimeSeries or DoseResponse -- see FindSim-Schema.json's Stimuli/Readouts/Experiment.design) and run it against the current model. The result appears in the Plots tab, alongside the reference data being reproduced.">
        <span>
          <Button component="label" variant="contained" fullWidth sx={MUTED_BUTTON_SX} disabled={findSimRunning}>
            {findSimFileName || 'Load experiment .json'}
            <input
              type="file"
              accept=".json"
              hidden
              onChange={(e) => e.target.files[0] && onFindSimFile(e.target.files[0])}
            />
          </Button>
        </span>
      </Tooltip>

      {findSimParsed && (
        <>
          <Stack direction="row" spacing={1} sx={{ mt: 1, mb: 0.5 }}>
            <Typography variant="body2">
              <strong>Design:</strong> {findSimParsed.design}
            </Typography>
          </Stack>

          <Typography variant="caption" color="text.secondary">
            Match each experiment entity to a pool in this model
          </Typography>
          <Stack spacing={1} sx={{ mt: 0.5, mb: 1 }}>
            {findSimBlocks.map((b) => (
              <FormControl key={b.id} fullWidth size="small" disabled={findSimRunning}>
                <InputLabel>
                  {b.entityName}
                  {b.alias && b.alias !== b.entityName ? ` (${b.alias})` : ''}
                </InputLabel>
                <Select
                  label={b.entityName}
                  value={findSimEntityMap[b.id] || ''}
                  onChange={(e) => onFindSimEntityChange(b.id, e.target.value)}
                >
                  {findSimParsed.poolOptions.map((p) => (
                    <MenuItem key={p.id} value={p.id}>
                      {p.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            ))}
          </Stack>

          <Button fullWidth variant="contained" sx={MUTED_BUTTON_SX} disabled={findSimRunning || !findSimAllMapped} onClick={onFindSimRun}>
            {findSimRunning ? 'Running…' : 'Run'}
          </Button>
        </>
      )}

      {findSimResult && findSimResult.score != null && (
        <>
          <Divider sx={{ my: 1 }} />
          <Typography variant="body2">
            NRMS score: <strong>{findSimResult.score.toFixed(3)}</strong>
          </Typography>
        </>
      )}

      {findSimError && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {findSimError}
        </Alert>
      )}
    </Box>
  );
}
