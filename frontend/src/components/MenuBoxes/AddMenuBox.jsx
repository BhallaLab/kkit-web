import { Box, Typography, Button, Stack, Divider, Alert } from '@mui/material';

export default function AddMenuBox({ onAddPool, onAddReac, onAddEnz, onDeleteSelected, selectedNode }) {
  const canAddEnz = selectedNode?.type === 'pool';

  return (
    <Box sx={{ p: 2, background: '#f5f5f5', borderRadius: 2, height: '100%' }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 1 }}>
        Add to model
      </Typography>
      <Stack spacing={1.5}>
        <Button variant="contained" onClick={onAddPool}>
          Add Pool
        </Button>
        <Button variant="contained" onClick={onAddReac}>
          Add Reaction
        </Button>
        <Button variant="contained" onClick={onAddEnz} disabled={!canAddEnz}>
          Add Enzyme (to selected pool)
        </Button>
        {!canAddEnz && (
          <Alert severity="info">
            Select a pool in the diagram first to attach a new enzyme to it.
          </Alert>
        )}
      </Stack>

      <Divider sx={{ my: 2 }} />

      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 1 }}>
        Remove
      </Typography>
      <Button
        variant="outlined"
        color="error"
        fullWidth
        onClick={onDeleteSelected}
        disabled={!selectedNode}
      >
        Delete Selected
      </Button>
    </Box>
  );
}
