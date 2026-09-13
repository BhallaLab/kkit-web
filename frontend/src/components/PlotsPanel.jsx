import Plot from 'react-plotly.js';
import { Box, Typography } from '@mui/material';

// Plotly's legend already toggles a trace's visibility on click (its
// default itemclick behavior) -- no extra wiring needed for that.
function PlotWindow({ traces, style }) {
  return (
    <Box sx={{ height: '100%', width: '100%', ...style }}>
      <Plot
        data={traces}
        layout={{
          autosize: true,
          margin: { t: 30, r: 20, b: 40, l: 50 },
          xaxis: { title: { text: 'Time (s)' } },
          yaxis: { title: { text: 'Conc (mM)' } },
          legend: { orientation: 'h' },
        }}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
        config={{ responsive: true }}
      />
    </Box>
  );
}

export default function PlotsPanel({ plotData, nodes }) {
  if (!plotData) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography color="text.secondary">
          Run a simulation (see the Run panel) to see concentration traces here.
        </Typography>
      </Box>
    );
  }

  const nameById = {};
  const colorById = {};
  const windowById = {};
  nodes.forEach((n) => {
    nameById[n.id] = n.data.name;
    colorById[n.id] = n.data.color;
    if (n.type === 'pool' && n.data.plotWindow) windowById[n.id] = n.data.plotWindow;
  });

  const toTrace = ([poolId, values]) => ({
    x: plotData.time,
    y: values,
    type: 'scatter',
    mode: 'lines',
    name: nameById[poolId] || poolId,
    line: { color: colorById[poolId] },
  });

  const entries = Object.entries(plotData.series).filter(([poolId]) => windowById[poolId]);
  const traces1 = entries.filter(([poolId]) => windowById[poolId] === 1).map(toTrace);
  const traces2 = entries.filter(([poolId]) => windowById[poolId] === 2).map(toTrace);

  if (traces1.length === 0 && traces2.length === 0) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography color="text.secondary">
          No molecules are marked for plotting yet. Drag one of the two plot
          icons (above the reaction layout) onto a molecule to plot it.
        </Typography>
      </Box>
    );
  }

  // Only one window in use -> it takes the full display; both in use ->
  // stacked one above the other, so an empty second window is never shown.
  const showBoth = traces1.length > 0 && traces2.length > 0;

  return (
    <Box sx={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}>
      {traces1.length > 0 && <PlotWindow traces={traces1} style={{ height: showBoth ? '50%' : '100%' }} />}
      {traces2.length > 0 && <PlotWindow traces={traces2} style={{ height: showBoth ? '50%' : '100%' }} />}
    </Box>
  );
}
