import { useState } from 'react';
import { Box, Typography, TextField, Button, Grid, CircularProgress, Alert } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RestartAltIcon from '@mui/icons-material/RestartAlt';

export default function RunMenuBox({ onStart, onReset, isRunning, error, lastRuntime }) {
  const [runtime, setRuntime] = useState('3000');
  const [plotDt, setPlotDt] = useState('1');

  const runtimeNum = parseFloat(runtime);
  const plotDtNum = parseFloat(plotDt);
  const invalid = !(runtimeNum > 0) || !(plotDtNum > 0);

  return (
    <Box sx={{ p: 2, background: '#f5f5f5', borderRadius: 2, height: '100%' }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 1.5 }}>
        Run simulation
      </Typography>

      <Grid container spacing={1.5} sx={{ mb: 2 }}>
        <Grid size={6}>
          <TextField
            fullWidth
            size="small"
            label="Runtime (s)"
            type="number"
            value={runtime}
            onChange={(e) => setRuntime(e.target.value)}
          />
        </Grid>
        <Grid size={6}>
          <TextField
            fullWidth
            size="small"
            label="Plot dt (s)"
            type="number"
            value={plotDt}
            onChange={(e) => setPlotDt(e.target.value)}
          />
        </Grid>
      </Grid>

      <Grid container spacing={1.5}>
        <Grid size={6}>
          <Button
            fullWidth
            variant="contained"
            startIcon={isRunning ? <CircularProgress size={18} color="inherit" /> : <PlayArrowIcon />}
            sx={{ bgcolor: 'success.main', '&:hover': { bgcolor: 'success.dark' } }}
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
            startIcon={<RestartAltIcon />}
            sx={{ bgcolor: '#ffeb3b', color: 'rgba(0, 0, 0, 0.87)', '&:hover': { bgcolor: '#fdd835' } }}
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
        <Alert severity="info" sx={{ mt: 2 }}>
          Simulating {runtime}s of model time -- this request blocks until it
          finishes.
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}
      {!isRunning && !error && lastRuntime && (
        <Alert severity="success" sx={{ mt: 2 }}>
          Last run: {lastRuntime}s. See the Plots tab for results.
        </Alert>
      )}
    </Box>
  );
}
