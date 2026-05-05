import React from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import LandingPage from './pages/LandingPage'
import GeneratingPage from './pages/GeneratingPage'
import PlayPage from './pages/PlayPage'
import HistoryPage from './pages/HistoryPage'
import './styles.css'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/generating/:gameId" element={<GeneratingPage />} />
        <Route path="/play/:gameId" element={<PlayPage />} />
        <Route path="/history" element={<HistoryPage />} />
      </Routes>
    </BrowserRouter>
  )
}
