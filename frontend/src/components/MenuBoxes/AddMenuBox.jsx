import { Box, Typography, Button, Tooltip } from '@mui/material';

// Adding pools/reactions/enzymes is now done via the drag-and-drop icon
// palette that sits directly above the reaction canvas (see
// EntityPalette.jsx) -- it's always visible while in layout mode, unlike
// this menu box, which the Properties panel pops in front of the moment a
// new entity is placed. This box now only holds Delete.
export default function AddMenuBox({ onDeleteSelected, selectedNode }) {
  const isEnzComplex = !!selectedNode?.data?.isEnzComplex;
  const disabledReason = !selectedNode
    ? 'Select a pool, reaction, or enzyme in the diagram to delete it. To add new entities, drag them from the icon palette above the reaction layout.'
    : isEnzComplex
    ? "This is an enzyme's complex pool -- it's deleted automatically when you delete the enzyme itself."
    : '';

  return (
    <Box sx={{ p: 2, background: '#f5f5f5', borderRadius: 2, height: '100%' }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 1 }}>
        Remove
      </Typography>
      <Tooltip title={disabledReason}>
        <span>
          <Button
            variant="outlined"
            color="error"
            fullWidth
            onClick={onDeleteSelected}
            disabled={!selectedNode || isEnzComplex}
          >
            Delete Selected
          </Button>
        </span>
      </Tooltip>
    </Box>
  );
}
