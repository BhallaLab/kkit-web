import Plot from 'react-plotly.js';
import { Box, Typography } from '@mui/material';

// Plotly's legend already toggles a trace's visibility on click (its
// default itemclick behavior) -- no extra wiring needed for that.
function PlotWindow({ traces, style, layout }) {
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
          ...layout,
        }}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
        config={{ responsive: true }}
      />
    </Box>
  );
}

function doseWindowContent(doseCurve, nameById) {
  const inputName = nameById[doseCurve.inputId] || 'dose';
  const outputName = nameById[doseCurve.outputId] || 'response';
  return {
    traces: [
      {
        x: doseCurve.points.map((p) => p.conc),
        y: doseCurve.points.map((p) => p.response),
        type: 'scatter',
        mode: 'lines+markers',
        name: `${outputName} vs ${inputName}`,
      },
    ],
    layout: {
      xaxis: { title: { text: `${inputName} concInit (mM)` }, type: 'log' },
      yaxis: { title: { text: `${outputName} conc (mM)` } },
    },
  };
}

export default function PlotsPanel({ plotData, nodes, doseCurve }) {
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

  const entries = plotData ? Object.entries(plotData.series).filter(([poolId]) => windowById[poolId]) : [];
  const traces1 = entries.filter(([poolId]) => windowById[poolId] === 1).map(toTrace);
  const traces2 = entries.filter(([poolId]) => windowById[poolId] === 2).map(toTrace);

  // A dose-response run claims one whole window slot (see App.jsx's
  // handleDoseStart for how 1-vs-2 is decided) and displaces whatever
  // that slot would otherwise have shown, rather than sharing it.
  const window1 = doseCurve?.window === 1
    ? doseWindowContent(doseCurve, nameById)
    : traces1.length > 0 ? { traces: traces1 } : null;
  const window2 = doseCurve?.window === 2
    ? doseWindowContent(doseCurve, nameById)
    : traces2.length > 0 ? { traces: traces2 } : null;

  if (!window1 && !window2) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography color="text.secondary">
          {plotData
            ? "No molecules are marked for plotting yet. Drag one of the two plot icons (above the reaction layout) onto a molecule to plot it."
            : 'Run a simulation (see the Run panel) or a Dose Response scan to see results here.'}
        </Typography>
      </Box>
    );
  }

  // Only one window in use -> it takes the full display; both in use ->
  // stacked one above the other, so an empty second window is never shown.
  const showBoth = window1 && window2;

  return (
    <Box sx={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}>
      {window1 && <PlotWindow {...window1} style={{ height: showBoth ? '50%' : '100%' }} />}
      {window2 && <PlotWindow {...window2} style={{ height: showBoth ? '50%' : '100%' }} />}
    </Box>
  );
}
