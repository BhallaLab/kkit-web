// One shared place for every unit conversion the Units menu's four
// choices (Time, Concentration, Volume, Length) actually drive -- see
// UnitsMenuBox.jsx for the menu itself and App.jsx for where the four
// choices actually live (lifted there so every dialog/plot can read the
// current selection).
//
// Every backend field this touches (moose_graph.py's describe_pool/
// describe_reac/describe_enz/describe_compartment) is native/unconverted
// -- mM for concentration, seconds for time, SI (m^3/m) for volume/
// length. This module is the ONLY place that ever multiplies/divides one
// of those native values by anything; PropertiesMenuBox/RunMenuBox/
// DoseResponseMenuBox/PlotsPanel all go through it rather than doing
// their own arithmetic.

export const TIME_UNITS = ['Seconds', 'Minutes'];
export const CONC_UNITS = ['nM', 'uM', 'mM', 'M'];
export const VOLUME_UNITS = ['SI', 'ul', 'nl', 'fl'];
export const LENGTH_UNITS = ['SI', 'um', 'mm'];

export const DEFAULT_TIME_UNIT = 'Seconds';
export const DEFAULT_CONC_UNIT = 'uM';
export const DEFAULT_VOLUME_UNIT = 'fl';
export const DEFAULT_LENGTH_UNIT = 'um';

// How many native units are in one of this unit -- e.g. TIME_SCALE.Minutes
// = 60 because 1 minute = 60 (native) seconds. "SI"/"Seconds"/"mM" (the
// backend's own native unit for that category) are always 1, a no-op.
const TIME_SCALE = { Seconds: 1, Minutes: 60 };
// Concentration's own native unit is mM (matching MOOSE), not a true SI
// unit -- named CONC_SCALE rather than folded into a generic "SI" concept
// for that reason.
const CONC_SCALE = { nM: 1e-6, uM: 1e-3, mM: 1, M: 1000 };
const VOLUME_SCALE = { SI: 1, ul: 1e-9, nl: 1e-12, fl: 1e-15 };
const LENGTH_SCALE = { SI: 1, um: 1e-6, mm: 1e-3 };

const TIME_ABBREV = { Seconds: 's', Minutes: 'min' };
export function timeUnitAbbrev(timeUnit) {
  return TIME_ABBREV[timeUnit];
}

// -- Plain quantities (a straightforward positive power of the unit, e.g.
// a concentration, a duration, a volume) -- converting *to* a bigger unit
// makes the displayed number *smaller*, so this divides.
export function toDisplayPlain(nativeValue, scaleTable, unit) {
  return nativeValue / scaleTable[unit];
}
export function toNativePlain(displayValue, scaleTable, unit) {
  return displayValue * scaleTable[unit];
}

export const conc = {
  toDisplay: (native, unit) => toDisplayPlain(native, CONC_SCALE, unit),
  toNative: (display, unit) => toNativePlain(display, CONC_SCALE, unit),
};
export const time = {
  toDisplay: (native, unit) => toDisplayPlain(native, TIME_SCALE, unit),
  toNative: (display, unit) => toNativePlain(display, TIME_SCALE, unit),
};
export const volume = {
  toDisplay: (native, unit) => toDisplayPlain(native, VOLUME_SCALE, unit),
  toNative: (display, unit) => toNativePlain(display, VOLUME_SCALE, unit),
};
export const length = {
  toDisplay: (native, unit) => toDisplayPlain(native, LENGTH_SCALE, unit),
  toNative: (display, unit) => toNativePlain(display, LENGTH_SCALE, unit),
};

// -- Pure time-based rates (kcat, k1/k2/k3, numKf/numKb -- all native
// s^-1, no concentration dependence at all) -- a rate carries a *negative*
// power of time, so this is the inverse direction from a plain duration:
// converting to a bigger time unit makes the displayed number *bigger*
// (a 0.1/s decay is a 6/min decay).
export function timeRateToDisplay(nativeValue, timeUnit) {
  return nativeValue * TIME_SCALE[timeUnit];
}
export function timeRateToNative(displayValue, timeUnit) {
  return displayValue / TIME_SCALE[timeUnit];
}
export function timeRateUnitLabel(timeUnit) {
  return `${TIME_ABBREV[timeUnit]}^-1`;
}

// -- Reaction rate constants (Reac.Kf/Kb) -- carry a negative power of
// *both* time and concentration: order 0/1 is a plain rate (no
// concentration term at all, same as timeRate* above); order >= 2 also
// picks up (order-1) inverse powers of concentration. Mirrors exactly
// what moose_graph.py's own _conc_scale/_rate_unit_label used to compute
// server-side (see describe_reac's own comment on why that moved here).
export function rateConstantToDisplay(nativeValue, order, concUnit, timeUnit) {
  const concPower = Math.max(order - 1, 0);
  return nativeValue * CONC_SCALE[concUnit] ** concPower * TIME_SCALE[timeUnit];
}
export function rateConstantToNative(displayValue, order, concUnit, timeUnit) {
  const concPower = Math.max(order - 1, 0);
  return displayValue / (CONC_SCALE[concUnit] ** concPower * TIME_SCALE[timeUnit]);
}
export function rateConstantUnitLabel(order, concUnit, timeUnit) {
  if (order < 2) return `${TIME_ABBREV[timeUnit]}^-1`;
  return `${concUnit}^-${order - 1}.${TIME_ABBREV[timeUnit]}^-1`;
}

// numKf/numKb specifically -- same time scaling as any other rate (see
// timeRateToDisplay), but never concentration-dependent (a molecule-count
// rate constant instead, see moose_graph.py's own comment on this) -- the
// label still carries the order-dependent "#^-(order-1)" molecule-count
// power a plain per_molecule=True _rate_unit_label used to, just with the
// time part now following whatever's currently selected.
export function numRateUnitLabel(order, timeUnit) {
  if (order < 2) return `${TIME_ABBREV[timeUnit]}^-1`;
  return `#^-${order - 1}.${TIME_ABBREV[timeUnit]}^-1`;
}

// -- Pool.diffConst/motorConst -- native SI (m^2/s and m/s respectively --
// LENGTH_SCALE's own "SI" = 1 native meter, matching the user's own
// statement of what these are in SI) -- scaled by the selected Length AND
// Time units together, the only two categories here that are.
export function diffConstToDisplay(nativeValue, lengthUnit, timeUnit) {
  return (nativeValue / LENGTH_SCALE[lengthUnit] ** 2) * TIME_SCALE[timeUnit];
}
export function diffConstToNative(displayValue, lengthUnit, timeUnit) {
  return (displayValue * LENGTH_SCALE[lengthUnit] ** 2) / TIME_SCALE[timeUnit];
}
export function diffConstUnitLabel(lengthUnit, timeUnit) {
  return `${lengthUnit}^2.${TIME_ABBREV[timeUnit]}^-1`;
}

export function motorConstToDisplay(nativeValue, lengthUnit, timeUnit) {
  return (nativeValue / LENGTH_SCALE[lengthUnit]) * TIME_SCALE[timeUnit];
}
export function motorConstToNative(displayValue, lengthUnit, timeUnit) {
  return (displayValue * LENGTH_SCALE[lengthUnit]) / TIME_SCALE[timeUnit];
}
export function motorConstUnitLabel(lengthUnit, timeUnit) {
  return `${lengthUnit}.${TIME_ABBREV[timeUnit]}^-1`;
}

// -- ConcChan.permeability -- MOOSE's own native units are vol/(#.s), i.e.
// 1/(numconc.s) (see ConcChan's own field doc: "Flux (#/s) = permeability *
// N * (#out/vol_out - #in/vol_in)") -- a *number*-concentration domain,
// unlike every other rate constant here (Kf/Kb/concK1/...), which are all
// already in the mM-consistent domain MOOSE's own Pool.conc uses. conc[mM]
// == numconc[#/m^3] / Avogadro (verified directly against a live Pool: n/
// volume/NA reproduces Pool.conc exactly) -- multiplying by Avogadro's
// number (matching moose-core's own basecode/header.h NA constant) converts
// permeability into that same mM-consistent domain first; after that it's a
// perfectly ordinary order-2 rate constant (one full inverse-concentration
// power, one inverse-time power) and reuses rateConstantToDisplay/ToNative/
// UnitLabel directly, the same way concK1 does.
const AVOGADRO = 6.0221415e23;
export function permeabilityToDisplay(nativeValue, concUnit, timeUnit) {
  return rateConstantToDisplay(nativeValue * AVOGADRO, 2, concUnit, timeUnit);
}
export function permeabilityToNative(displayValue, concUnit, timeUnit) {
  return rateConstantToNative(displayValue, 2, concUnit, timeUnit) / AVOGADRO;
}
export function permeabilityUnitLabel(concUnit, timeUnit) {
  return rateConstantUnitLabel(2, concUnit, timeUnit);
}

// A pool's own n is never unit-scaled (same reasoning as n/nInit elsewhere
// in this app) -- this instead converts a *recorded conc trace* (see
// sim_runner.py's run_simulation, which only ever records conc) into n
// directly, for the Plots panel's own "conc vs # of molecules" toggle.
// conc[mM] == n / (Avogadro * volume[m^3]) (see permeabilityToDisplay's own
// comment) -- so n = conc * Avogadro * volume; volumeM3 is each pool's own
// already-known describe_pool volume, not anything the Units menu affects.
export function concToN(concMM, volumeM3) {
  return concMM * AVOGADRO * volumeM3;
}

// ConcChan.flux -- a live, read-only diagnostic (#/s, molecule count per
// time, see ConcChan's own field doc) -- same time-only scaling as
// timeRateToDisplay/ToNative (its value math is identical; only the label
// needs its own "#" numerator, since flux is a molecule-count *rate*, not
// an inverse-time-only quantity like k1/k2/kcat).
export function fluxUnitLabel(timeUnit) {
  return `#.${TIME_ABBREV[timeUnit]}^-1`;
}
