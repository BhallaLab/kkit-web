import { AppBar, Toolbar, Button, Box } from '@mui/material';
import FolderIcon from '@mui/icons-material/Folder';
import TuneIcon from '@mui/icons-material/Tune';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import BuildIcon from '@mui/icons-material/Build';
import StairsIcon from '@mui/icons-material/Stairs';
import StraightenIcon from '@mui/icons-material/Straighten';
import FileMenuBox from './components/MenuBoxes/FileMenuBox';
import PropertiesMenuBox from './components/MenuBoxes/PropertiesMenuBox';
import RunMenuBox from './components/MenuBoxes/RunMenuBox';
import ToolsMenuBox from './components/MenuBoxes/ToolsMenuBox';
import UnitsMenuBox from './components/MenuBoxes/UnitsMenuBox';
import DoseResponseMenuBox from './components/MenuBoxes/DoseResponseMenuBox';
import MainDisplay from './components/MainDisplay';

const MENU_ITEMS = [
  { key: 'File', label: 'File', Icon: FolderIcon },
  { key: 'Run', label: 'Run', Icon: PlayCircleIcon },
  { key: 'Properties', label: 'Properties', Icon: TuneIcon },
  { key: 'Tools', label: 'Tools', Icon: BuildIcon },
  { key: 'Units', label: 'Units', Icon: StraightenIcon },
  { key: 'DoseResponse', label: 'Dose Response', Icon: StairsIcon },
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
  onAutoLayoutRecursiveFlow,
  onClearLayoutLocks,
  layoutRunning,
  layoutProgress,
  selectedGroupScore,
  onUndoLayout,
  canUndoLayout,
  onAddPool,
  onAddReac,
  onAddEnz,
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
  timeUnit,
  setTimeUnit,
  concUnit,
  setConcUnit,
  volumeUnit,
  setVolumeUnit,
  lengthUnit,
  setLengthUnit,
  ...canvasProps
}) {
  const menuComponents = {
    File: (
      <FileMenuBox
        onGraphLoaded={onGraphLoaded}
        status={status}
        flowGraph={canvasProps.flowGraph}
        plots={plots}
        collapsedMap={collapsedMap}
        runtime={runtime}
        setRuntime={setRuntime}
        plotDt={plotDt}
        setPlotDt={setPlotDt}
      />
    ),
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
        onAutoLayoutRecursiveFlow={onAutoLayoutRecursiveFlow}
        onClearLayoutLocks={onClearLayoutLocks}
        layoutRunning={layoutRunning}
        layoutProgress={layoutProgress}
        selectedGroupScore={selectedGroupScore}
        onUndoLayout={onUndoLayout}
        canUndoLayout={canUndoLayout}
        timeUnit={timeUnit}
        concUnit={concUnit}
        volumeUnit={volumeUnit}
        lengthUnit={lengthUnit}
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
        timeUnit={timeUnit}
        findSimParsed={findSimParsed}
        findSimEntityMap={findSimEntityMap}
        findSimFileName={findSimFileName}
        findSimRunning={findSimRunning}
        findSimError={findSimError}
        findSimResult={findSimResult}
        onFindSimFile={onFindSimFile}
        onFindSimEntityChange={onFindSimEntityChange}
        onFindSimRun={onFindSimRun}
      />
    ),
    Tools: <ToolsMenuBox flowGraph={canvasProps.flowGraph} />,
    Units: (
      <UnitsMenuBox
        timeUnit={timeUnit}
        setTimeUnit={setTimeUnit}
        concUnit={concUnit}
        setConcUnit={setConcUnit}
        volumeUnit={volumeUnit}
        setVolumeUnit={setVolumeUnit}
        lengthUnit={lengthUnit}
        setLengthUnit={setLengthUnit}
      />
    ),
    DoseResponse: (
      <DoseResponseMenuBox
        flowGraph={canvasProps.flowGraph}
        params={doseParams}
        setParams={setDoseParams}
        running={doseRunning}
        error={doseError}
        onStart={onDoseStart}
        onHalt={onDoseHalt}
        concUnit={concUnit}
        timeUnit={timeUnit}
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
        <Box id="printable-canvas" sx={{ width: '67%', height: '100%' }}>
          <MainDisplay
            {...canvasProps}
            plotData={plotData}
            findSimCurve={findSimResult}
            selectedNode={selectedNode}
            onAddPool={onAddPool}
            onAddReac={onAddReac}
            onAddEnz={onAddEnz}
            concUnit={concUnit}
            timeUnit={timeUnit}
          />
        </Box>
      </Box>
    </Box>
  );
}
