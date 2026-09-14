import { useState } from 'react';
import {
  Box,
  Typography,
  Button,
  Grid,
  Divider,
  Alert,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
} from '@mui/material';

const API_BASE = `http://${window.location.hostname}:5001`;

const REPORT_EXT = { markdown: 'md', tsv: 'tsv', latex: 'tex' };

// Groups and compartments are the only sensible "root" to compare from --
// mirrors the original xcomparemodel.g, which compares two group subtrees
// (by default /kinetics itself, i.e. a compartment).
function compareRootOptions(nodes) {
  return nodes.filter((n) => n.type === 'group' || n.type === 'compartment');
}

// Mirrors the original xcomparemodel.g's own report layout: a header
// naming the two sides, a combined "elements present in one but not the
// other" pair of lists, then a separately-labeled block per entity kind
// ("Comparing pool values", "Comparing enzyme values", ...) -- rendered
// as visually distinct sections rather than one flat list, with a final
// summary line.
function CompareReport({ result, labelA, labelB }) {
  return (
    <Box sx={{ mt: 1, maxHeight: 320, overflowY: 'auto', fontSize: 12, background: 'white', p: 1.5, borderRadius: 1 }}>
      <Typography sx={{ fontSize: 12, fontWeight: 'bold', mb: 1 }}>
        Comparing {labelA} (reference) with {labelB} (comparison)
      </Typography>

      <Typography sx={{ fontSize: 12, fontWeight: 'bold', mt: 1.5 }}>
        Elements only in {labelA}:
      </Typography>
      {result.onlyInA.length === 0 ? (
        <div>(none)</div>
      ) : (
        result.onlyInA.map((o, i) => (
          <div key={`a-${i}`}>
            {i + 1}. {o.path} ({o.kind})
          </div>
        ))
      )}

      <Typography sx={{ fontSize: 12, fontWeight: 'bold', mt: 1.5 }}>
        Elements only in {labelB}:
      </Typography>
      {result.onlyInB.length === 0 ? (
        <div>(none)</div>
      ) : (
        result.onlyInB.map((o, i) => (
          <div key={`b-${i}`}>
            {i + 1}. {o.path} ({o.kind})
          </div>
        ))
      )}

      {result.valueBlocks.map((block) => (
        <Box key={block.kind} sx={{ mt: 1.5 }}>
          <Typography sx={{ fontSize: 12, fontWeight: 'bold' }}>Comparing {block.title.toLowerCase()} values:</Typography>
          {block.diffs.length === 0 ? (
            <div>(no differences)</div>
          ) : (
            block.diffs.map((d, i) => (
              <div key={`${block.kind}-${i}`}>
                {i + 1}. {d.path} {d.field}={String(d.a)} &ne; {String(d.b)}
              </div>
            ))
          )}
        </Box>
      ))}

      <Divider sx={{ my: 1 }} />
      <Typography sx={{ fontSize: 12, fontWeight: 'bold' }}>
        {result.totalDiffCount === 0
          ? `No differences found between ${labelA} and ${labelB}`
          : `${result.totalDiffCount} difference${result.totalDiffCount === 1 ? '' : 's'} between ${labelA} and ${labelB}`}
      </Typography>
    </Box>
  );
}

export default function ToolsMenuBox({ flowGraph }) {
  const [modelSize, setModelSize] = useState(null);
  const [sizeError, setSizeError] = useState(null);

  const [dtResult, setDtResult] = useState(null);
  const [dtError, setDtError] = useState(null);

  const rootOptions = compareRootOptions(flowGraph.nodes);
  const [rootA, setRootA] = useState('');
  const [rootB, setRootB] = useState('');
  // Bundled with the result (rather than derived at render time) so the
  // labels always match whichever comparison actually produced this
  // result, even if rootA/rootB selections change afterward.
  const [compare, setCompare] = useState(null);
  const [compareError, setCompareError] = useState(null);

  const [reportFormat, setReportFormat] = useState('markdown');
  const [reportError, setReportError] = useState(null);

  const handleModelSize = () => {
    fetch(`${API_BASE}/api/tools/model_size`)
      .then((r) => r.json())
      .then((res) => {
        if (res.error) {
          setSizeError(res.error);
          return;
        }
        setSizeError(null);
        setModelSize(res);
      })
      .catch((err) => setSizeError(String(err)));
  };

  const handleFindDt = (err) => {
    fetch(`${API_BASE}/api/tools/find_dt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ err }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.error) {
          setDtError(res.error);
          return;
        }
        setDtError(null);
        setDtResult(res);
      })
      .catch((err) => setDtError(String(err)));
  };

  const handleCompareWithin = () => {
    if (!rootA || !rootB) {
      setCompareError('Pick both groups to compare');
      return;
    }
    const labelA = rootOptions.find((n) => n.id === rootA)?.name ?? rootA;
    const labelB = rootOptions.find((n) => n.id === rootB)?.name ?? rootB;
    fetch(`${API_BASE}/api/tools/compare_groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootA, rootB }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.error) {
          setCompareError(res.error);
          return;
        }
        setCompareError(null);
        setCompare({ result: res, labelA, labelB });
      })
      .catch((err) => setCompareError(String(err)));
  };

  const handleCompareFile = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const isSbml = /\.(xml|sbml)$/i.test(file.name);
    const labelA = rootA ? rootOptions.find((n) => n.id === rootA)?.name ?? rootA : 'current model';
    const labelB = `file "${file.name}"`;
    const reader = new FileReader();
    reader.onload = () => {
      fetch(`${API_BASE}/api/tools/compare_file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: reader.result,
          fileType: isSbml ? 'sbml' : 'g',
          rootA: rootA || undefined,
        }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.error) {
            setCompareError(res.error);
            return;
          }
          setCompareError(null);
          setCompare({ result: res, labelA, labelB });
        })
        .catch((err) => setCompareError(String(err)));
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  // Same showSaveFilePicker-with-fallback pattern as FileMenuBox's SBML
  // save -- a real native save dialog where available, a plain download
  // otherwise.
  const handleDownloadReport = async () => {
    const res = await fetch(`${API_BASE}/api/tools/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: reportFormat }),
    }).then((r) => r.json());
    if (res.error) {
      setReportError(res.error);
      return;
    }
    setReportError(null);
    const ext = REPORT_EXT[reportFormat];
    const blob = new Blob([res.content], { type: 'text/plain' });

    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: `model_report.${ext}`,
          types: [{ description: 'Model report', accept: { 'text/plain': [`.${ext}`] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('showSaveFilePicker failed, falling back to plain download:', err);
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `model_report.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Box sx={{ p: 2, background: '#f5f5f5', borderRadius: 2, height: '100%', overflowY: 'auto' }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 1.5 }}>
        Tools
      </Typography>

      <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
        Model size
      </Typography>
      <Button variant="outlined" size="small" fullWidth sx={{ mt: 0.5 }} onClick={handleModelSize}>
        Calculate model size
      </Button>
      {sizeError && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {sizeError}
        </Alert>
      )}
      {modelSize && !sizeError && (
        <Box sx={{ mt: 1, fontSize: 13 }}>
          {Object.entries(modelSize).map(([kind, count]) => (
            <div key={kind}>
              {kind}: {count}
            </div>
          ))}
        </Box>
      )}

      <Divider sx={{ my: 2 }} />

      <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
        Timestep (dt) estimate
      </Typography>
      <Grid container spacing={1} sx={{ mt: 0.5 }}>
        <Grid size={6}>
          <Button fullWidth variant="outlined" size="small" onClick={() => handleFindDt(0.01)}>
            dt for 1% accuracy
          </Button>
        </Grid>
        <Grid size={6}>
          <Button fullWidth variant="outlined" size="small" onClick={() => handleFindDt(0.05)}>
            dt for 5% accuracy
          </Button>
        </Grid>
      </Grid>
      {dtError && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {dtError}
        </Alert>
      )}
      {dtResult && !dtError && (
        dtResult.dt == null ? (
          <Alert severity="warning" sx={{ mt: 1 }}>
            No reaction/enzyme with a nonzero rate to estimate from.
          </Alert>
        ) : (
          <Alert severity="info" sx={{ mt: 1 }}>
            dt &asymp; {dtResult.dt.toPrecision(4)} s, limited by {dtResult.stiffest}
          </Alert>
        )
      )}

      <Divider sx={{ my: 2 }} />

      <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
        Compare models
      </Typography>
      <Grid container spacing={1} sx={{ mt: 0.5 }}>
        <Grid size={6}>
          <FormControl fullWidth size="small">
            <InputLabel>Group 1</InputLabel>
            <Select label="Group 1" value={rootA} onChange={(e) => setRootA(e.target.value)}>
              {rootOptions.map((n) => (
                <MenuItem key={n.id} value={n.id}>
                  {n.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Grid>
        <Grid size={6}>
          <FormControl fullWidth size="small">
            <InputLabel>Group 2</InputLabel>
            <Select label="Group 2" value={rootB} onChange={(e) => setRootB(e.target.value)}>
              {rootOptions.map((n) => (
                <MenuItem key={n.id} value={n.id}>
                  {n.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Grid>
      </Grid>
      <Button fullWidth variant="outlined" size="small" sx={{ mt: 1 }} onClick={handleCompareWithin}>
        Compare within model
      </Button>
      <Button fullWidth variant="outlined" component="label" size="small" sx={{ mt: 1 }}>
        Compare against file...
        <input type="file" accept=".g,.xml,.sbml" hidden onChange={handleCompareFile} />
      </Button>
      {compareError && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {compareError}
        </Alert>
      )}
      {compare && !compareError && (
        <CompareReport result={compare.result} labelA={compare.labelA} labelB={compare.labelB} />
      )}

      <Divider sx={{ my: 2 }} />

      <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
        Export model report
      </Typography>
      <FormControl fullWidth size="small" sx={{ mt: 0.5 }}>
        <InputLabel>Format</InputLabel>
        <Select label="Format" value={reportFormat} onChange={(e) => setReportFormat(e.target.value)}>
          <MenuItem value="markdown">Markdown</MenuItem>
          <MenuItem value="tsv">TSV</MenuItem>
          <MenuItem value="latex">LaTeX</MenuItem>
        </Select>
      </FormControl>
      <Button fullWidth variant="contained" size="small" sx={{ mt: 1 }} onClick={handleDownloadReport}>
        Download report
      </Button>
      {reportError && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {reportError}
        </Alert>
      )}
    </Box>
  );
}
