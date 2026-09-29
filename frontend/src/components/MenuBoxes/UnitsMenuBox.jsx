import { useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  Radio,
  RadioGroup,
  FormControlLabel,
  FormControl,
  FormLabel,
  Divider,
} from '@mui/material';
import { TIME_UNITS, CONC_UNITS, VOLUME_UNITS, LENGTH_UNITS, volume, length } from '../../unitConversions';

// The four radio choices here are lifted state (see App.jsx) -- every
// other dialog/plot reads them from there via unitConversions.js, so this
// menu just displays/edits them, the same as any other controlled field.
// "Default compartment size" below is the one thing that's still purely
// local/unwired -- nothing creates a new compartment from it yet.

// Matches App.jsx's own /api/new_model default compartment volume -- a
// sensible starting point for "default compartment size" rather than an
// arbitrary round number.
const DEFAULT_VOLUME_SI = 1.6667e-21;

function diameterToVolume(diameter) {
  return (Math.PI / 6) * diameter ** 3;
}

function volumeToDiameter(vol) {
  return Math.cbrt((6 * vol) / Math.PI);
}

// Same display-rounding convention as PropertiesMenuBox's own formatNumber
// -- duplicated locally rather than shared, since this is the only other
// place it's needed so far.
function formatNumber(value) {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs < 1e-3 || abs >= 1e6) return value.toExponential(4);
  return String(Number(value.toPrecision(5)));
}

function UnitRadioGroup({ label, options, value, onChange }) {
  return (
    <FormControl component="fieldset" sx={{ display: 'block', mb: 2 }}>
      <FormLabel component="legend" sx={{ fontWeight: 'bold', fontSize: 14, color: 'text.primary' }}>
        {label}
      </FormLabel>
      <RadioGroup row value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((opt) => (
          <FormControlLabel key={opt} value={opt} control={<Radio size="small" />} label={opt} />
        ))}
      </RadioGroup>
    </FormControl>
  );
}

export default function UnitsMenuBox({
  timeUnit,
  setTimeUnit,
  concUnit,
  setConcUnit,
  volumeUnit,
  setVolumeUnit,
  lengthUnit,
  setLengthUnit,
}) {
  // The default compartment's own size -- a spherical volume/diameter
  // pair, editing either recomputes the other (same sphere-equivalent
  // convention PropertiesMenuBox's own compartment volume/diameter row
  // already uses, see diameter_to_volume). Each field keeps its own raw
  // typed string (so reformatting the *other* field on every keystroke
  // never fights whichever one the user is actually typing into) --
  // volumeSI is the one canonical numeric value both are ever derived
  // from.
  const [volumeSI, setVolumeSI] = useState(DEFAULT_VOLUME_SI);
  const [volumeText, setVolumeText] = useState(() => formatNumber(volume.toDisplay(DEFAULT_VOLUME_SI, 'fl')));
  const [diameterText, setDiameterText] = useState(() =>
    formatNumber(length.toDisplay(volumeToDiameter(DEFAULT_VOLUME_SI), 'um'))
  );

  const handleVolumeUnitChange = (unit) => {
    setVolumeUnit(unit);
    setVolumeText(formatNumber(volume.toDisplay(volumeSI, unit)));
  };
  const handleLengthUnitChange = (unit) => {
    setLengthUnit(unit);
    setDiameterText(formatNumber(length.toDisplay(volumeToDiameter(volumeSI), unit)));
  };

  const handleVolumeTextChange = (text) => {
    setVolumeText(text);
    const parsed = parseFloat(text);
    if (!Number.isFinite(parsed)) return;
    const nextVolumeSI = volume.toNative(parsed, volumeUnit);
    setVolumeSI(nextVolumeSI);
    setDiameterText(formatNumber(length.toDisplay(volumeToDiameter(nextVolumeSI), lengthUnit)));
  };
  const handleDiameterTextChange = (text) => {
    setDiameterText(text);
    const parsed = parseFloat(text);
    if (!Number.isFinite(parsed)) return;
    const nextVolumeSI = diameterToVolume(length.toNative(parsed, lengthUnit));
    setVolumeSI(nextVolumeSI);
    setVolumeText(formatNumber(volume.toDisplay(nextVolumeSI, volumeUnit)));
  };

  return (
    <Box sx={{ p: 2, background: '#f5f5f5', borderRadius: 2, height: '100%', overflowY: 'auto' }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 1.5 }}>
        Units
      </Typography>

      <UnitRadioGroup label="Time units" options={TIME_UNITS} value={timeUnit} onChange={setTimeUnit} />
      <UnitRadioGroup label="Concentration units" options={CONC_UNITS} value={concUnit} onChange={setConcUnit} />
      <UnitRadioGroup label="Volume units" options={VOLUME_UNITS} value={volumeUnit} onChange={handleVolumeUnitChange} />
      <UnitRadioGroup label="Length units" options={LENGTH_UNITS} value={lengthUnit} onChange={handleLengthUnitChange} />

      <Divider sx={{ my: 2 }} />

      <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
        Default compartment size
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        Assumes a spherical compartment -- editing either field recomputes the other.
      </Typography>
      <Box sx={{ display: 'flex', gap: 1.5 }}>
        <TextField
          fullWidth
          size="small"
          label={`Volume (${volumeUnit})`}
          type="number"
          value={volumeText}
          onChange={(e) => handleVolumeTextChange(e.target.value)}
        />
        <TextField
          fullWidth
          size="small"
          label={`Diameter (${lengthUnit})`}
          type="number"
          value={diameterText}
          onChange={(e) => handleDiameterTextChange(e.target.value)}
        />
      </Box>
    </Box>
  );
}
