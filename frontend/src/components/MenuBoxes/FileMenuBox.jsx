import { useState } from 'react';
import { Box, Typography, TextField, Button, Stack, Divider, Alert } from '@mui/material';

const API_BASE = `http://${window.location.hostname}:5001`;

export default function FileMenuBox({ onLoadGFile, onGraphLoaded, status }) {
  const [path, setPath] = useState('/home/bhalla/homework/KKIT/kkit11/examples/feedback.g');

  const handleSaveSbml = () => {
    fetch(`${API_BASE}/api/save_sbml`, { method: 'POST' })
      .then((r) => r.json())
      .then((res) => {
        if (res.error) return;
        const blob = new Blob([res.sbml], { type: 'application/xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'model.xml';
        a.click();
        URL.revokeObjectURL(url);
      });
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
        .then(onGraphLoaded);
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  return (
    <Box sx={{ p: 2, background: '#f5f5f5', borderRadius: 2, height: '100%' }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 1 }}>
        Legacy kkit (.g) file
      </Typography>
      <Stack spacing={1.5}>
        <TextField
          label="Server-side path"
          size="small"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <Button variant="contained" onClick={() => onLoadGFile(path)}>
          Load .g file
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
      </Stack>

      {status && (
        <Alert severity="info" sx={{ mt: 2 }}>
          {status}
        </Alert>
      )}
    </Box>
  );
}
