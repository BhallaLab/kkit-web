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

// Two traces sharing one window, like a normal plot vs a dose-response
// curve don't -- a solid line for the simulated trace, open-circle markers
// with error bars (from the expt data's own sem/stderr column) for the
// reference data being reproduced. The score (if computable, see
// findsim_runner.py's _nrms -- None when the point counts don't line up)
// goes in the title rather than the legend, since it describes the pair
// as a whole, not either individual trace.
function findSimWindowContent(curve) {
  const scoreText = curve.score != null ? `NRMS score: ${curve.score.toFixed(3)}` : '';
  return {
    traces: [
      {
        x: curve.simPoints.map((p) => p[0]),
        y: curve.simPoints.map((p) => p[1]),
        type: 'scatter',
        mode: 'lines+markers',
        name: 'Simulated',
      },
      {
        x: curve.exptPoints.map((p) => p[0]),
        y: curve.exptPoints.map((p) => p[1]),
        error_y: { type: 'data', array: curve.exptPoints.map((p) => p[2] || 0), visible: true },
        type: 'scatter',
        mode: 'markers',
        marker: { symbol: 'circle-open', size: 9 },
        name: 'Experiment',
      },
    ],
    layout: {
      xaxis: { title: { text: curve.xLabel }, type: curve.design === 'DoseResponse' ? 'log' : 'linear' },
      yaxis: { title: { text: curve.yLabel } },
      title: scoreText ? { text: scoreText, font: { size: 13 } } : undefined,
    },
  };
}

export default function PlotsPanel({ plotData, nodes, doseCurve, findSimCurve }) {
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

  // A dose-response run or a FindSim playback each claim one whole window
  // slot (see App.jsx's handleDoseStart/handleFindSimRun for how 1-vs-2 is
  // decided) and displace whatever that slot would otherwise have shown,
  // rather than sharing it. Both can't sensibly target the same window at
  // once (each is a single, separately-triggered run) -- dose wins the
  // rare case they do, arbitrarily, same as either would displace normal
  // pool traces on its own.
  const overlayFor = (win) =>
    doseCurve?.window === win ? doseWindowContent(doseCurve, nameById)
    : findSimCurve?.window === win ? findSimWindowContent(findSimCurve)
    : null;
  const window1 = overlayFor(1) ?? (traces1.length > 0 ? { traces: traces1 } : null);
  const window2 = overlayFor(2) ?? (traces2.length > 0 ? { traces: traces2 } : null);

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
