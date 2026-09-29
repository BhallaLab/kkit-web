// Shared, deliberately understated styling for every left-side menu panel
// -- originally FileMenuBox's own convention (see its old inline comment,
// now here instead): flat, subdued, compact, rather than MUI's default
// vivid "contained" palette and generous spacing, which read as louder/
// heavier than routine controls in a menu this dense actually need. Every
// MenuBoxes/*.jsx panel imports from here rather than redefining its own
// version, so a future tweak (a shade, a spacing value) only has one place
// to change.

// Applied to every routine button in a menu panel -- deliberately NOT
// MUI's default vivid blue/green/red/yellow "contained" palette (which
// draws far more attention than these actions need), and deliberately
// smaller than MUI's own "small" Button default (still too tall for a
// menu this dense).
export const MUTED_BUTTON_SX = {
  bgcolor: '#e0e0e0',
  color: 'rgba(0, 0, 0, 0.87)',
  boxShadow: 'none',
  fontSize: '0.75rem',
  minHeight: 0,
  lineHeight: 1.5,
  py: 0.4,
  '&:hover': { bgcolor: '#cfcfcf', boxShadow: 'none' },
};

// Applied to every text/select field in a menu panel -- MUI's own
// size="small" shrinks padding but leaves the input/label at the theme's
// default (1rem) font, which reads as oversized next to this menu's own
// compact buttons.
export const COMPACT_FIELD_SX = {
  '& .MuiInputBase-root': { fontSize: '0.8rem' },
  '& .MuiInputLabel-root': { fontSize: '0.8rem' },
};

// A section header within a menu panel -- smaller and lighter than MUI's
// own subtitle1 default, matching the same restrained weight every other
// label in these panels already uses (e.g. DoseResponseMenuBox's own
// "Concentration range" caption, which this generalizes into a single
// shared style instead of an ad hoc one-off).
export const SECTION_HEADER_SX = {
  fontWeight: 600,
  color: 'text.secondary',
  fontSize: '0.8rem',
  textTransform: 'uppercase',
  letterSpacing: 0.3,
};

// Start/Reset (and any other single primary "go"/"stop" action a panel
// has) override the muted palette above -- these two specifically benefit
// from being unambiguous at a glance the way FileMenuBox's own routine
// buttons don't need to be. Same compact sizing as MUTED_BUTTON_SX, just
// with MUI's own vivid success/error color restored.
export const START_BUTTON_SX = {
  ...MUTED_BUTTON_SX,
  bgcolor: 'success.main',
  color: '#fff',
  '&:hover': { bgcolor: 'success.dark' },
};
export const STOP_BUTTON_SX = {
  ...MUTED_BUTTON_SX,
  bgcolor: 'error.main',
  color: '#fff',
  '&:hover': { bgcolor: 'error.dark' },
};

// The standard raised (OFF) / pressed-in (ON) bezel look for a toggle --
// explicit per-side border colors (white on the top/left, a dark slate on
// the bottom/right) for OFF, reversed for ON -- the classic skeuomorphic
// button trick. (`border-style: outset`/`inset`, which auto-derives this
// same shading from one border-color, turns out not to render it visibly
// in current Chrome once an explicit border-color is also set -- verified
// directly: the border was there, computed style showed outset/inset
// correctly, but with no perceptible highlight/shadow -- hence spelling
// out all four sides here instead of relying on that.) Overrides MUI's own
// default "fused, shared-border" ToggleButtonGroup layout (each button
// normally drops its own left border and overlaps its neighbor by 1px to
// look like one seamless bar) with a small gap instead, so each button
// keeps its own complete bezel and actually reads as an individually
// raised/pressed control rather than one flat segmented bar. A light
// pastel blue (not MUI's own vivid primary.main) fills the pressed/ON
// button -- distinct enough to read as "on" without the contrasty look
// clashing with this menu's own muted palette.
const BEZEL_LIGHT = '#ffffff';
const BEZEL_DARK = '#78909c';
export const TOGGLE_GROUP_SX = {
  gap: '4px',
  '& .MuiToggleButtonGroup-grouped': {
    margin: '0 !important',
    borderRadius: '4px !important',
    borderWidth: '2px !important',
    borderStyle: 'solid !important',
    borderTopColor: `${BEZEL_LIGHT} !important`,
    borderLeftColor: `${BEZEL_LIGHT} !important`,
    borderBottomColor: `${BEZEL_DARK} !important`,
    borderRightColor: `${BEZEL_DARK} !important`,
    bgcolor: '#eceff1',
    color: 'rgba(0, 0, 0, 0.87)',
    fontSize: '0.75rem',
    textTransform: 'none',
    py: 0.3,
    minWidth: 0,
    flex: '1 1 0',
    // Long labels (e.g. "LSODA: deterministic") wrap onto a second line
    // *within* their own button instead of forcing the whole button to
    // grow past its flex share and overflow the group's own width.
    whiteSpace: 'normal',
    lineHeight: 1.2,
    '&:hover': { bgcolor: '#e1f5fe' },
    '&.Mui-selected': {
      borderTopColor: `${BEZEL_DARK} !important`,
      borderLeftColor: `${BEZEL_DARK} !important`,
      borderBottomColor: `${BEZEL_LIGHT} !important`,
      borderRightColor: `${BEZEL_LIGHT} !important`,
      bgcolor: '#bbdefb',
      color: 'rgba(0, 0, 0, 0.87)',
      '&:hover': { bgcolor: '#90caf9' },
    },
  },
};
