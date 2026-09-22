import { AppBar, Toolbar, Button, Box } from '@mui/material';
import FolderIcon from '@mui/icons-material/Folder';
import TuneIcon from '@mui/icons-material/Tune';
import AddCircleIcon from '@mui/icons-material/AddCircle';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import BuildIcon from '@mui/icons-material/Build';
import StairsIcon from '@mui/icons-material/Stairs';
import ScienceIcon from '@mui/icons-material/Science';
import FileMenuBox from './components/MenuBoxes/FileMenuBox';
import PropertiesMenuBox from './components/MenuBoxes/PropertiesMenuBox';
import AddMenuBox from './components/MenuBoxes/AddMenuBox';
import RunMenuBox from './components/MenuBoxes/RunMenuBox';
import ToolsMenuBox from './components/MenuBoxes/ToolsMenuBox';
import DoseResponseMenuBox from './components/MenuBoxes/DoseResponseMenuBox';
import FindSimMenuBox from './components/MenuBoxes/FindSimMenuBox';
import MainDisplay from './components/MainDisplay';

const MENU_ITEMS = [
  { key: 'File', label: 'File', Icon: FolderIcon },
  { key: 'Run', label: 'Run', Icon: PlayCircleIcon },
  { key: 'Properties', label: 'Properties', Icon: TuneIcon },
  { key: 'Add', label: 'Add', Icon: AddCircleIcon },
  { key: 'Tools', label: 'Tools', Icon: BuildIcon },
  { key: 'DoseResponse', label: 'Dose Response', Icon: StairsIcon },
  { key: 'FindSim', label: 'FindSim', Icon: ScienceIcon },
];

export default function AppLayout({
  activeMenu,
  setActiveMenu,
  status,
  onGraphLoaded,
  selectedNode,
  selectedParentName,
  onSaveNode,
  onToggleFlip,
  onToggleCollapse,
  onAutoLayoutGroup,
  onAutoLayoutGroupByFlow,
  onAutoLayoutRecursive,
  onClearLayoutLocks,
  selectedGroupScore,
  onUndoLayout,
  canUndoLayout,
  onAddPool,
  onAddReac,
  onAddEnz,
  onDeleteSelected,
  onStartRun,
  onResetRun,
  isRunning,
  runError,
  lastRuntime,
  runtime,
  setRuntime,
  plotDt,
  setPlotDt,
  plotData,
  plots,
  collapsedMap,
  doseParams,
  setDoseParams,
  doseRunning,
  doseError,
  onDoseStart,
  onDoseHalt,
  findSimParsed,
  findSimEntityMap,
  findSimFileName,
  findSimRunning,
  findSimError,
  findSimResult,
  onFindSimFile,
  onFindSimEntityChange,
  onFindSimRun,
  ...canvasProps
}) {
  const menuComponents = {
    File: (
      <FileMenuBox
        onGraphLoaded={onGraphLoaded}
        status={status}
        plots={plots}
        collapsedMap={collapsedMap}
        runtime={runtime}
        setRuntime={setRuntime}
        plotDt={plotDt}
        setPlotDt={setPlotDt}
      />
    ),
    Add: <AddMenuBox onDeleteSelected={onDeleteSelected} selectedNode={selectedNode} />,
    Properties: (
      <PropertiesMenuBox
        node={selectedNode}
        parentName={selectedParentName}
        onSave={onSaveNode}
        onToggleFlip={onToggleFlip}
        onToggleCollapse={onToggleCollapse}
        onAutoLayoutGroup={onAutoLayoutGroup}
        onAutoLayoutGroupByFlow={onAutoLayoutGroupByFlow}
        onAutoLayoutRecursive={onAutoLayoutRecursive}
        onClearLayoutLocks={onClearLayoutLocks}
        selectedGroupScore={selectedGroupScore}
        onUndoLayout={onUndoLayout}
        canUndoLayout={canUndoLayout}
      />
    ),
    Run: (
      <RunMenuBox
        onStart={onStartRun}
        onReset={onResetRun}
        isRunning={isRunning}
        error={runError}
        lastRuntime={lastRuntime}
        runtime={runtime}
        setRuntime={setRuntime}
        plotDt={plotDt}
        setPlotDt={setPlotDt}
      />
    ),
    Tools: <ToolsMenuBox flowGraph={canvasProps.flowGraph} />,
    DoseResponse: (
      <DoseResponseMenuBox
        flowGraph={canvasProps.flowGraph}
        params={doseParams}
        setParams={setDoseParams}
        running={doseRunning}
        error={doseError}
        onStart={onDoseStart}
        onHalt={onDoseHalt}
      />
    ),
    FindSim: (
      <FindSimMenuBox
        parsed={findSimParsed}
        entityMap={findSimEntityMap}
        fileName={findSimFileName}
        running={findSimRunning}
        error={findSimError}
        result={findSimResult}
        onFile={onFindSimFile}
        onEntityChange={onFindSimEntityChange}
        onRun={onFindSimRun}
      />
    ),
  };

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppBar position="static">
        <Toolbar sx={{ display: 'flex', justifyContent: 'space-around', flexWrap: 'wrap' }}>
          {MENU_ITEMS.map(({ key, label, Icon }) => (
            <Button
              key={key}
              color="inherit"
              onClick={() => setActiveMenu(key)}
              sx={{ flexDirection: 'column', color: activeMenu === key ? 'orange' : 'inherit' }}
            >
              <Icon sx={{ fontSize: 32, mb: 0.5 }} />
              {label}
            </Button>
          ))}
        </Toolbar>
      </AppBar>
      <Box sx={{ display: 'flex', flexGrow: 1, p: 2, gap: 2, minHeight: 0 }}>
        <Box sx={{ width: '33%', height: '100%' }}>{menuComponents[activeMenu]}</Box>
        <Box sx={{ width: '67%', height: '100%' }}>
          <MainDisplay
            {...canvasProps}
            plotData={plotData}
            findSimCurve={findSimResult}
            selectedNode={selectedNode}
            onAddPool={onAddPool}
            onAddReac={onAddReac}
            onAddEnz={onAddEnz}
          />
        </Box>
      </Box>
    </Box>
  );
}
