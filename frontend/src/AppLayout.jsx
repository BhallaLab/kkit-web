import { AppBar, Toolbar, Button, Box } from '@mui/material';
import FolderIcon from '@mui/icons-material/Folder';
import TuneIcon from '@mui/icons-material/Tune';
import AddCircleIcon from '@mui/icons-material/AddCircle';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import FileMenuBox from './components/MenuBoxes/FileMenuBox';
import PropertiesMenuBox from './components/MenuBoxes/PropertiesMenuBox';
import AddMenuBox from './components/MenuBoxes/AddMenuBox';
import RunMenuBox from './components/MenuBoxes/RunMenuBox';
import MainDisplay from './components/MainDisplay';

const MENU_ITEMS = [
  { key: 'File', label: 'File', Icon: FolderIcon },
  { key: 'Add', label: 'Add', Icon: AddCircleIcon },
  { key: 'Properties', label: 'Properties', Icon: TuneIcon },
  { key: 'Run', label: 'Run', Icon: PlayCircleIcon },
];

export default function AppLayout({
  activeMenu,
  setActiveMenu,
  status,
  loadFile,
  onGraphLoaded,
  selectedNode,
  onSaveNode,
  onAddPool,
  onAddReac,
  onAddEnz,
  onDeleteSelected,
  onStartRun,
  onResetRun,
  isRunning,
  runError,
  lastRuntime,
  plotData,
  ...canvasProps
}) {
  const menuComponents = {
    File: <FileMenuBox onLoadGFile={loadFile} onGraphLoaded={onGraphLoaded} status={status} />,
    Add: (
      <AddMenuBox
        onAddPool={onAddPool}
        onAddReac={onAddReac}
        onAddEnz={onAddEnz}
        onDeleteSelected={onDeleteSelected}
        selectedNode={selectedNode}
      />
    ),
    Properties: <PropertiesMenuBox node={selectedNode} onSave={onSaveNode} />,
    Run: (
      <RunMenuBox
        onStart={onStartRun}
        onReset={onResetRun}
        isRunning={isRunning}
        error={runError}
        lastRuntime={lastRuntime}
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
          <MainDisplay {...canvasProps} plotData={plotData} />
        </Box>
      </Box>
    </Box>
  );
}
