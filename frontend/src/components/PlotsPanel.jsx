import Plot from 'react-plotly.js';
import { Box, Typography } from '@mui/material';
import { conc, time, timeUnitAbbrev, concToN } from '../unitConversions';

// Plotly's legend already toggles a trace's visibility on click (its
// default itemclick behavior) -- no extra wiring needed for that.
function PlotWindow({ traces, style, layout, timeUnit, concUnit }) {
  return (
    <Box sx={{ height: '100%', width: '100%', ...style }}>
      <Plot
        data={traces}
        layout={{
          autosize: true,
          margin: { t: 30, r: 20, b: 40, l: 50 },
          xaxis: { title: { text: `Time (${timeUnitAbbrev(timeUnit)})` } },
          yaxis: { title: { text: `Conc (${concUnit})` } },
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

function doseWindowContent(doseCurve, nameById, concUnit) {
  const inputName = nameById[doseCurve.inputId] || 'dose';
  const outputName = nameById[doseCurve.outputId] || 'response';
  return {
    traces: [
      {
        x: doseCurve.points.map((p) => conc.toDisplay(p.conc, concUnit)),
        y: doseCurve.points.map((p) => conc.toDisplay(p.response, concUnit)),
        type: 'scatter',
        mode: 'lines+markers',
        name: `${outputName} vs ${inputName}`,
      },
    ],
    layout: {
      xaxis: { title: { text: `${inputName} concInit (${concUnit})` }, type: 'log' },
      yaxis: { title: { text: `${outputName} conc (${concUnit})` } },
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

export default function PlotsPanel({ plotData, previousPlotData, plotDomain, nodes, doseCurve, findSimCurve, concUnit, timeUnit }) {
  const nameById = {};
  const colorById = {};
  const volumeById = {};
  const windowById = {};
  nodes.forEach((n) => {
    nameById[n.id] = n.data.name;
    colorById[n.id] = n.data.color;
    if (n.type === 'pool') {
      volumeById[n.id] = n.data.volume;
      if (n.data.plotWindow) windowById[n.id] = n.data.plotWindow;
    }
  });

  // plotData.time/series come back from /api/run/start in native units
  // (seconds, mM -- see sim_runner.py's run_simulation) -- converted here
  // to whatever the Units menu currently has selected, or, if the Plots
  // panel's own "# of molecules" toggle is on, into each pool's raw n
  // instead (see unitConversions.js's own concToN, which needs that pool's
  // volume -- never unit-scaled itself, same as Pool's own n field
  // elsewhere). Same "not live, only when this panel is actually showing"
  // convention every other dialog uses (a fresh run always re-renders this
  // panel from scratch anyway, so there's no separate "becomes visible"
  // moment to gate on the way a persistent form field needs one).
  const yValue = (poolId, v) => (plotDomain === 'n' ? concToN(v, volumeById[poolId]) : conc.toDisplay(v, concUnit));

  // `dashed` renders the Overlay Plots toggle's own "previous run" layer
  // (see App.jsx's handleStartRun) -- same pool, same color, just a dashed
  // line and a "(previous)" legend suffix so it's clearly the older trace,
  // not a second live series.
  const makeToTrace =
    (data, dashed) =>
    ([poolId, values]) => ({
      x: data.time.map((t) => time.toDisplay(t, timeUnit)),
      y: values.map((v) => yValue(poolId, v)),
      type: 'scatter',
      mode: 'lines',
      name: dashed ? `${nameById[poolId] || poolId} (previous)` : nameById[poolId] || poolId,
      line: { color: colorById[poolId], dash: dashed ? 'dot' : 'solid' },
    });

  const entries = plotData ? Object.entries(plotData.series).filter(([poolId]) => windowById[poolId]) : [];
  const prevEntries = previousPlotData
    ? Object.entries(previousPlotData.series).filter(([poolId]) => windowById[poolId])
    : [];
  const toTrace = makeToTrace(plotData || {}, false);
  const toPrevTrace = makeToTrace(previousPlotData || {}, true);
  const tracesForWindow = (win) => [
    ...prevEntries.filter(([poolId]) => windowById[poolId] === win).map(toPrevTrace),
    ...entries.filter(([poolId]) => windowById[poolId] === win).map(toTrace),
  ];
  const traces1 = tracesForWindow(1);
  const traces2 = tracesForWindow(2);
  const yAxisTitle = plotDomain === 'n' ? '# of molecules' : `Conc (${concUnit})`;

  // A dose-response run or a FindSim playback each claim one whole window
  // slot (see App.jsx's handleDoseStart/handleFindSimRun for how 1-vs-2 is
  // decided) and displace whatever that slot would otherwise have shown,
  // rather than sharing it. Both can't sensibly target the same window at
  // once (each is a single, separately-triggered run) -- dose wins the
  // rare case they do, arbitrarily, same as either would displace normal
  // pool traces on its own.
  const overlayFor = (win) =>
    doseCurve?.window === win ? doseWindowContent(doseCurve, nameById, concUnit)
    : findSimCurve?.window === win ? findSimWindowContent(findSimCurve)
    : null;
  const window1 = overlayFor(1) ?? (traces1.length > 0 ? { traces: traces1, layout: { yaxis: { title: { text: yAxisTitle } } } } : null);
  const window2 = overlayFor(2) ?? (traces2.length > 0 ? { traces: traces2, layout: { yaxis: { title: { text: yAxisTitle } } } } : null);

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
      {window1 && (
        <PlotWindow {...window1} style={{ height: showBoth ? '50%' : '100%' }} timeUnit={timeUnit} concUnit={concUnit} />
      )}
      {window2 && (
        <PlotWindow {...window2} style={{ height: showBoth ? '50%' : '100%' }} timeUnit={timeUnit} concUnit={concUnit} />
      )}
    </Box>
  );
}
