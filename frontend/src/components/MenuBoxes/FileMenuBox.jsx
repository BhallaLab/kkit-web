import { useMemo, useState } from 'react';
import {
  Box,
  TextField,
  Button,
  Stack,
  Divider,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  MenuItem,
} from '@mui/material';
import { MUTED_BUTTON_SX, COMPACT_FIELD_SX } from '../../menuStyle';

const API_BASE = `http://${window.location.hostname}:5001`;

// A real, saveable choice always overwrites this -- but until then, it
// reads unambiguously as "we don't actually know," rather than silently
// showing "CC BY" as if the user (or the file) had actually chosen it.
const NO_LICENSE = '(not set)';
const LICENSE_OPTIONS = [NO_LICENSE, 'CC BY', 'CC BY-SA', 'GPLv3', 'None'];

// Order/labels match the File menu's own read-only model-info line.
// Computed directly from the live flowGraph (the same node list the canvas
// itself renders, keyed by the exact node "type" strings build_graph/
// toFlowGraph emit -- see model_tools.py's own model_size, which this
// mirrors) rather than a separate backend fetch: a fetch here raced
// App.jsx's own /api/new_model bootstrap call on every fresh page/window
// load (both fire on mount, with no ordering guarantee between them, and
// /api/new_model -- which actually builds a new CubeMesh etc. server-side
// -- reliably takes longer than a trivial model_size scan of whatever the
// *previous* window's model still was) -- verified directly: "New Window"
// deterministically showed the old window's own counts. flowGraph, by
// contrast, only ever updates from this exact window's own successful
// load, so there's nothing left to race.
const MODEL_INFO_FIELDS = [
  ['compartment', 'compartments'],
  ['group', 'groups'],
  ['pool', 'pools'],
  ['enz', 'enz'],
  ['reac', 'reac'],
];

function formatModelInfo(nodes) {
  const counts = {};
  // n.type is React Flow's own rendering type -- remapped for groups (to
  // 'kkitGroup', see App.jsx's own REACT_FLOW_NODE_TYPE) -- the semantic
  // type every other count here actually wants lives on n.data.type
  // instead (same distinction PropertiesMenuBox's own titleFor relies on).
  for (const n of nodes) counts[n.data.type] = (counts[n.data.type] || 0) + 1;
  return MODEL_INFO_FIELDS.map(([key, label]) => `${counts[key] || 0} ${label}`).join(' · ');
}

// Always sent as-is to showSaveFilePicker/the <a download> fallback -- no
// ".xml" appended here, so the user can see and edit the exact final name
// (including the extension) rather than fighting an invisible suffix.
function withXmlExtension(name) {
  const trimmed = (name || '').trim() || 'model';
  return /\.xml$/i.test(trimmed) ? trimmed : `${trimmed}.xml`;
}

function formatTimestamp(iso) {
  if (!iso) return '(not yet saved)';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function FileMenuBox({
  onGraphLoaded,
  flowGraph,
  plots,
  collapsedMap,
  runtime,
  setRuntime,
  plotDt,
  setPlotDt,
  onPrintLayout,
  onSaveLayoutSvg,
  sx,
  scaleIcons,
}) {
  const [modelNotes, setModelNotes] = useState('');
  const [fileName, setFileName] = useState('model.xml');
  const [svgFileName, setSvgFileName] = useState('layout.svg');
  const [pdfFileName, setPdfFileName] = useState('layout.pdf');
  const [creator, setCreator] = useState('');
  const [license, setLicense] = useState(NO_LICENSE);
  const [modified, setModified] = useState('');

  const [aboutKkitOpen, setAboutKkitOpen] = useState(false);
  const [aboutMooseOpen, setAboutMooseOpen] = useState(false);

  const modelInfoText = useMemo(() => formatModelInfo(flowGraph?.nodes || []), [flowGraph]);

  const handleLoadGFile = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    // Future saves default to this file's own name (with the extension
    // swapped to .xml, since Save always produces SBML).
    setFileName(withXmlExtension(file.name.replace(/\.g$/i, '')));
    const reader = new FileReader();
    reader.onload = () => {
      fetch(`${API_BASE}/api/upload_gfile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: reader.result }),
      })
        .then((r) => r.json())
        .then((res) => {
          // A legacy .g file's own model-level notes (see
          // _extract_g_model_notes) are the only one of these five it can
          // actually carry -- creator/license/modified have no equivalent
          // in the format at all, so those three always reset the same
          // way loading an SBML file with none of its own would.
          setModelNotes(res.notes || '');
          setCreator('');
          setLicense(NO_LICENSE);
          setModified('');
          onGraphLoaded(res);
        });
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  // A plain <a download> always saves silently to the browser's default
  // downloads folder under whatever name it's given -- window.showSaveFilePicker
  // (where available; matches jardesigner's own FileMenuBox) gives a real
  // native save dialog instead, falling back to the download link otherwise.
  // Firefox doesn't implement showSaveFilePicker at all (verified directly),
  // so the inline "File name" field above is the ONLY way a Firefox user
  // gets to name the saved file -- the fallback download must actually use
  // it, not a hardcoded "model.xml".
  const handleSave = async () => {
    const name = withXmlExtension(fileName);
    const nowIso = new Date().toISOString();
    const res = await fetch(`${API_BASE}/api/save_sbml`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notes: modelNotes,
        plots,
        collapsed: collapsedMap,
        runtime,
        plotDt,
        creator,
        license: license === NO_LICENSE ? '' : license,
        modified: nowIso,
        sx,
        scaleIcons,
      }),
    }).then((r) => r.json());
    if (res.error) return;
    setFileName(name);
    setModified(nowIso);
    const blob = new Blob([res.sbml], { type: 'application/xml' });

    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'SBML file', accept: { 'application/xml': ['.xml'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (err) {
        // User cancelled the picker -- nothing more to do, not a failure.
        if (err.name === 'AbortError') return;
        // Any other failure (a browser that defines showSaveFilePicker but
        // doesn't fully support it, a permissions quirk, etc.) falls
        // through to the plain download below instead of just giving up.
        console.error('showSaveFilePicker failed, falling back to plain download:', err);
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleLoadSbmlFile = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      fetch(`${API_BASE}/api/load_sbml`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sbml: reader.result }),
      })
        .then((r) => r.json())
        .then((res) => {
          setModelNotes(res.notes || '');
          // Older files (or ones saved before this existed) simply have
          // no runSettings -- leave whatever's currently configured alone
          // rather than resetting it to something arbitrary (there's no
          // "correct" runtime/plotDt to fall back to).
          if (res.runSettings) {
            setRuntime(res.runSettings.runtime);
            setPlotDt(res.runSettings.plotDt);
          }
          // Creator/license/modified, unlike runSettings, DO have an
          // obvious correct fallback (blank/default) -- so every load
          // resets them from this file, one way or the other, rather than
          // ever leaving a previous file's values showing against a new
          // one that simply never had them.
          setCreator(res.modelMeta?.creator || '');
          setLicense(res.modelMeta?.license || NO_LICENSE);
          setModified(res.modelMeta?.modified || '');
          onGraphLoaded(res);
        });
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const handleNew = () => {
    window.open(window.location.href, '_blank').focus();
  };

  const handleClose = () => {
    window.close();
    // If this tab wasn't opened by JavaScript, close() is silently blocked
    // by the browser -- the timeout only fires if the window is still open.
    setTimeout(() => {
      alert('Please close this tab manually (Ctrl+W or Cmd+W).');
    }, 500);
  };

  return (
    <Box sx={{ p: 2, background: '#f5f5f5', borderRadius: 2, height: '100%', overflowY: 'auto' }}>
      <Stack spacing={0.5}>
        <Button variant="contained" sx={MUTED_BUTTON_SX} onClick={handleNew}>
          New Window
        </Button>
        <Button variant="contained" sx={MUTED_BUTTON_SX} component="label">
          Load SBML Model
          <input type="file" accept=".xml,.sbml" hidden onChange={handleLoadSbmlFile} />
        </Button>
        <Button variant="contained" sx={MUTED_BUTTON_SX} component="label">
          Import Legacy .g Model
          <input type="file" accept=".g" hidden onChange={handleLoadGFile} />
        </Button>
        <Typography variant="caption" color="text.secondary" sx={{ px: 0.5 }}>
          {modelInfoText}
        </Typography>
        <Button variant="contained" sx={MUTED_BUTTON_SX} onClick={handleClose}>
          Close
        </Button>

        <Divider sx={{ my: 0.25 }} />

        <Box sx={{ display: 'flex', gap: 0.5 }}>
          <Button
            variant="contained"
            sx={{ ...MUTED_BUTTON_SX, minWidth: 100, flexShrink: 0 }}
            onClick={handleSave}
          >
            Save
          </Button>
          <TextField
            fullWidth
            size="small"
            label="File name"
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            sx={COMPACT_FIELD_SX}
          />
        </Box>
        <TextField
          fullWidth
          size="small"
          label="Model Creator"
          value={creator}
          onChange={(e) => setCreator(e.target.value)}
          sx={COMPACT_FIELD_SX}
        />
        <TextField
          select
          fullWidth
          size="small"
          label="License"
          value={license}
          onChange={(e) => setLicense(e.target.value)}
          sx={COMPACT_FIELD_SX}
        >
          {LICENSE_OPTIONS.map((opt) => (
            <MenuItem key={opt} value={opt}>
              {opt}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          fullWidth
          size="small"
          label="Model Notes"
          multiline
          minRows={2}
          maxRows={4}
          value={modelNotes}
          onChange={(e) => setModelNotes(e.target.value)}
          sx={COMPACT_FIELD_SX}
        />
        <TextField
          fullWidth
          size="small"
          label="Last Modified"
          value={formatTimestamp(modified)}
          slotProps={{ input: { readOnly: true } }}
          variant="filled"
          sx={COMPACT_FIELD_SX}
        />

        <Divider sx={{ my: 0.25 }} />

        <Box sx={{ display: 'flex', gap: 0.5 }}>
          <Button
            variant="contained"
            sx={{ ...MUTED_BUTTON_SX, minWidth: 100, flexShrink: 0 }}
            onClick={() => onSaveLayoutSvg(svgFileName)}
          >
            Layout -&gt; SVG
          </Button>
          <TextField
            fullWidth
            size="small"
            label="File name"
            value={svgFileName}
            onChange={(e) => setSvgFileName(e.target.value)}
            sx={COMPACT_FIELD_SX}
          />
        </Box>
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          <Button
            variant="contained"
            sx={{ ...MUTED_BUTTON_SX, minWidth: 100, flexShrink: 0 }}
            onClick={() => onPrintLayout(pdfFileName)}
          >
            Layout -&gt; PDF
          </Button>
          <TextField
            fullWidth
            size="small"
            label="File name"
            value={pdfFileName}
            onChange={(e) => setPdfFileName(e.target.value)}
            sx={COMPACT_FIELD_SX}
          />
        </Box>
        <Button variant="contained" sx={MUTED_BUTTON_SX} onClick={() => setAboutKkitOpen(true)}>
          About KKIT
        </Button>
        <Button variant="contained" sx={MUTED_BUTTON_SX} onClick={() => setAboutMooseOpen(true)}>
          About MOOSE
        </Button>

        <Divider sx={{ my: 0.25 }} />
      </Stack>

      <Dialog open={aboutKkitOpen} onClose={() => setAboutKkitOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>About KKIT</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            KKIT is a browser-based editor and simulator for chemical kinetic models, built around
            MOOSE. It reads and writes SBML, and imports legacy GENESIS/kkit .g files.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button variant="contained" sx={MUTED_BUTTON_SX} onClick={() => setAboutKkitOpen(false)}>
            Close
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={aboutMooseOpen} onClose={() => setAboutMooseOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>About MOOSE</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            MOOSE, the Multiscale Object-Oriented Simulation Environment, is the simulation engine
            underneath KKIT -- see moose.ncbs.res.in for documentation and source.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button variant="contained" sx={MUTED_BUTTON_SX} onClick={() => setAboutMooseOpen(false)}>
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
