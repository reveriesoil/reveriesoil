import { HashRouter, Routes, Route } from 'react-router-dom'
import LandingPage from './pages/LandingPage'
import GeneratingPage from './pages/GeneratingPage'
import PlayPage from './pages/PlayPage'
import HistoryPage from './pages/HistoryPage'
import './index.css'

// Capacitor 下无法使用 BrowserRouter（本地文件路径问题），改用 HashRouter
export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/generating/:gameId" element={<GeneratingPage />} />
        <Route path="/play/:gameId" element={<PlayPage />} />
        <Route path="/history" element={<HistoryPage />} />
      </Routes>
    </HashRouter>
  )
}
