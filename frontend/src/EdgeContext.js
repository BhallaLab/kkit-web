import { createContext } from 'react';

// Lets the edge's bend-point handle call back up to App.jsx's edge state
// (select-on-click, reposition-on-drag) without threading callbacks through
// edge.data, which would risk stale closures.
export const EdgeActionsContext = createContext({
  selectEdge: () => {},
  moveEdgeVia: () => {},
});
