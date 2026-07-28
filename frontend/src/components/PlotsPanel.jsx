import Plot from 'react-plotly.js';
import { Box, Typography } from '@mui/material';

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
  nodes.forEach((n) => {
    nameById[n.id] = n.data.name;
  });

  const traces = Object.entries(plotData.series).map(([poolId, values]) => ({
    x: plotData.time,
    y: values,
    type: 'scatter',
    mode: 'lines',
    name: nameById[poolId] || poolId,
  }));

  return (
    <Box sx={{ height: '100%', width: '100%' }}>
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
