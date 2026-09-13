import { createContext } from 'react';

// Lets a group/compartment's NodeResizer (nodes.jsx) call back up to
// App.jsx's node state (persisting a resize) without threading a callback
// through node.data, which would risk stale closures.
export const NodeActionsContext = createContext({
  onContainerResize: () => {},
});
