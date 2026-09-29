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
  Tooltip,
} from '@mui/material';
import { conc } from '../../unitConversions';
import { MUTED_BUTTON_SX, SECTION_HEADER_SX, TOGGLE_GROUP_SX } from '../../menuStyle';

// Same display-rounding convention as PropertiesMenuBox's own formatNumber.
function formatNumber(value) {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs < 1e-3 || abs >= 1e6) return value.toExponential(4);
  return String(Number(value.toPrecision(5)));
}

// Mirrors xdoser.g's own 8 concentration-range toggles -- decade 0 is
// 1e-7 mM, each subsequent decade x10 (see sim_runner.py's
// dose_concentrations, which this must stay in step with; the decade
// *index* sent to the backend is unaffected by the unit chosen here --
// only this dropdown's own label text reflects it).
const DECADE_BASE_MM = [1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1];

function decadeLabels(concUnit) {
  return DECADE_BASE_MM.map((mM) => `${formatNumber(conc.toDisplay(mM, concUnit))} ${concUnit}`);
}

// "group/name" (or just "name" at the top level) -- the same
// immediate-container disambiguation PropertiesMenuBox's own "Parent"
// field shows (moose names repeat constantly across different branches of
// a model), generalized here to an arbitrary pool id rather than only
// whichever node is currently selected, since Pick lets the user choose a
// pool that was never selected at all.
function poolLabel(poolId, nodes) {
  if (!poolId) return null;
  const pool = nodes.find((n) => n.id === poolId);
  if (!pool) return null;
  const parent = pool.data.parentId ? nodes.find((n) => n.id === pool.data.parentId) : null;
  return parent ? `${parent.data.name}/${pool.data.name}` : pool.data.name;
}

// All of this panel's own state (which pools, the range, the toggles, the
// in-progress/completed run) lives in App.jsx, not here -- only the
// currently-selected left menu is ever mounted (see AppLayout's
// menuComponents), so a plain local useState would be thrown away the
// moment the user switched to another tab and back. The resulting curve
// itself is rendered in the Plots tab (see PlotsPanel), not inline here.
export default function DoseResponseMenuBox({ flowGraph, params, setParams, running, error, onStart, onHalt, onArmPick, concUnit }) {
  const setField = (key, value) => setParams((p) => ({ ...p, [key]: value }));
  const decadeLabelsForUnit = decadeLabels(concUnit);

  const inputLabel = poolLabel(params.inputId, flowGraph.nodes);
  const outputLabel = poolLabel(params.outputId, flowGraph.nodes);

  // A dropdown listing every pool doesn't scale -- a model with a few
  // hundred pools would make choosing the dose/monitor pool a search
  // exercise. Pick instead arms a one-shot "click a pool in the Reaction
  // Layout" mode (see App.jsx's handleArmDosePick/onNodeClick) -- the
  // button itself doubles as the readout, showing the picked pool's own
  // "group/name" once chosen, or the armed/idle prompt otherwise.
  const pickButton = (field, label, current) => (
    <Button
      fullWidth
      variant="contained"
      sx={MUTED_BUTTON_SX}
      disabled={running}
      onClick={() => onArmPick(field)}
      title={current ? 'Click again to pick a different pool' : 'Click, then click a pool in Reaction Layout'}
    >
      {params.picking === field ? 'Click a pool in Reaction Layout… (click to cancel)' : current ? `${label}: ${current}` : `Pick ${label.toLowerCase()}`}
    </Button>
  );

  return (
    <Box sx={{ p: 2, background: '#f5f5f5', borderRadius: 2, height: '100%', overflowY: 'auto' }}>
      <Tooltip title="Steps the variable pool's concentration through a log-spaced range and records the monitored pool's steady-state response at each level, using the Run panel's runtime to let the system settle. The resulting curve appears in the Plots tab.">
        <Typography sx={{ ...SECTION_HEADER_SX, mb: 1, width: 'fit-content' }}>Dose Response</Typography>
      </Tooltip>

      <Box sx={{ mb: 0.5 }}>{pickButton('input', 'Variable pool (dose)', inputLabel)}</Box>
      <Box sx={{ mb: 1 }}>{pickButton('output', 'Monitored pool (response)', outputLabel)}</Box>

      <Typography variant="caption" color="text.secondary">
        Concentration range
      </Typography>
      <Grid container spacing={1} sx={{ mt: 0.5, mb: 1 }}>
        <Grid size={6}>
          <FormControl fullWidth size="small" disabled={running}>
            <InputLabel>From</InputLabel>
            <Select label="From" value={params.minDecade} onChange={(e) => setField('minDecade', e.target.value)}>
              {decadeLabelsForUnit.map((l, i) => (
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
              {decadeLabelsForUnit.map((l, i) => (
                <MenuItem key={i} value={i}>
                  {l}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Grid>
      </Grid>

      {/* Each toggle group gets its own full-width row -- squeezing two
          side by side (the old 2-column layout) left each button only a
          quarter of the panel's own width, not enough for labels like
          "Reset each level"/"Continue series" to fit without overflowing
          into the next column. */}
      <Box sx={{ mb: 0.5 }}>
        <ToggleButtonGroup fullWidth size="small" exclusive disabled={running} value={params.buffered} onChange={(e, v) => v !== null && setField('buffered', v)} sx={TOGGLE_GROUP_SX}>
          <ToggleButton value title="Free conc is forced to the dose value (a real clamp)">
            Buffered
          </ToggleButton>
          <ToggleButton value={false} title="Each dose is added to the pool's current concentration">
            Incremented
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>
      <Box sx={{ mb: 0.5 }}>
        <ToggleButtonGroup
          fullWidth
          size="small"
          exclusive
          disabled={running}
          value={params.resetEachLevel}
          onChange={(e, v) => v !== null && setField('resetEachLevel', v)}
          sx={TOGGLE_GROUP_SX}
        >
          <ToggleButton value title="Reinitializes the whole model before each dose level">
            Reset each level
          </ToggleButton>
          <ToggleButton value={false} title="Lets the system evolve continuously from the previous level">
            Continue series
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>
      <Box sx={{ mb: 0.5 }}>
        <ToggleButtonGroup fullWidth size="small" exclusive disabled={running} value={params.decreasing} onChange={(e, v) => v !== null && setField('decreasing', v)} sx={TOGGLE_GROUP_SX}>
          <ToggleButton value={false}>Increasing</ToggleButton>
          <ToggleButton value>Decreasing</ToggleButton>
        </ToggleButtonGroup>
      </Box>
      <Box sx={{ mb: 1 }}>
        <ToggleButtonGroup fullWidth size="small" exclusive disabled={running} value={params.fine} onChange={(e, v) => v !== null && setField('fine', v)} sx={TOGGLE_GROUP_SX}>
          <ToggleButton value={false}>Coarse (3/decade)</ToggleButton>
          <ToggleButton value title="10 points per decade instead of 3">
            Fine (10/decade)
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Grid container spacing={1}>
        <Grid size={running ? 6 : 12}>
          <Button fullWidth variant="contained" sx={MUTED_BUTTON_SX} disabled={running} onClick={onStart}>
            Start
          </Button>
        </Grid>
        {running && (
          <Grid size={6}>
            <Button fullWidth variant="contained" sx={MUTED_BUTTON_SX} onClick={onHalt}>
              Halt
            </Button>
          </Grid>
        )}
      </Grid>

      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
    </Box>
  );
}
