import { useState } from 'react';
import { Box, Typography, TextField, Button, Stack, Divider, Alert } from '@mui/material';

const API_BASE = `http://${window.location.hostname}:5001`;

export default function FileMenuBox({ onGraphLoaded, status, plots, runtime, setRuntime, plotDt, setPlotDt }) {
  const [modelNotes, setModelNotes] = useState('');

  const handleLoadGFile = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      fetch(`${API_BASE}/api/upload_gfile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: reader.result }),
      })
        .then((r) => r.json())
        .then((res) => {
          // Legacy .g files carry no model-level notes field.
          setModelNotes('');
          onGraphLoaded(res);
        });
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  // A plain <a download> always saves silently to the browser's default
  // downloads folder as "model.xml" -- window.showSaveFilePicker (where
  // available; matches jardesigner's own FileMenuBox) gives a real native
  // save dialog instead, falling back to the download link otherwise.
  const handleSaveSbml = async () => {
    const res = await fetch(`${API_BASE}/api/save_sbml`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: modelNotes, plots, runtime, plotDt }),
    }).then((r) => r.json());
    if (res.error) return;
    const blob = new Blob([res.sbml], { type: 'application/xml' });

    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: 'model.xml',
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
    a.download = 'model.xml';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleLoadSbmlFile = (event) => {
    const file = event.target.files[0];
    if (!file) return;
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
          // rather than resetting it to something arbitrary.
          if (res.runSettings) {
            setRuntime(res.runSettings.runtime);
            setPlotDt(res.runSettings.plotDt);
          }
          onGraphLoaded(res);
        });
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const handleNew = () => {
    window.open(window.location.href, '_blank').focus();
  };

  const handleQuit = () => {
    window.close();
    // If this tab wasn't opened by JavaScript, close() is silently blocked
    // by the browser -- the timeout only fires if the window is still open.
    setTimeout(() => {
      alert('Please close this tab manually (Ctrl+W or Cmd+W).');
    }, 500);
  };

  return (
    <Box sx={{ p: 2, background: '#f5f5f5', borderRadius: 2, height: '100%', overflowY: 'auto' }}>
      <Stack spacing={1.5}>
        <Button variant="contained" onClick={handleNew}>
          New window
        </Button>
      </Stack>

      <Divider sx={{ my: 2 }} />

      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 1 }}>
        Legacy kkit (.g) file
      </Typography>
      <Stack spacing={1.5}>
        <Button variant="contained" component="label">
          Load .g file
          <input type="file" accept=".g" hidden onChange={handleLoadGFile} />
        </Button>
      </Stack>

      <Divider sx={{ my: 2 }} />

      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 1 }}>
        Native format (SBML)
      </Typography>
      <Stack spacing={1.5}>
        <Button variant="contained" onClick={handleSaveSbml}>
          Save as SBML
        </Button>
        <Button variant="outlined" component="label">
          Load SBML file
          <input type="file" accept=".xml,.sbml" hidden onChange={handleLoadSbmlFile} />
        </Button>
        <TextField
          label="Model notes"
          size="small"
          multiline
          minRows={3}
          value={modelNotes}
          onChange={(e) => setModelNotes(e.target.value)}
          helperText="Saved into the SBML file's model notes; loaded back from any SBML file that has them."
        />
      </Stack>

      <Divider sx={{ my: 2 }} />

      <Stack spacing={1.5}>
        <Button variant="contained" color="error" onClick={handleQuit}>
          Quit
        </Button>
      </Stack>

      {status && (
        <Alert severity="info" sx={{ mt: 2 }}>
          {status}
        </Alert>
      )}
    </Box>
  );
}
