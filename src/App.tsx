import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import Dashboard from './screens/Dashboard';
import Holdings from './screens/Holdings';
import Transactions from './screens/Transactions';
import Analysis from './screens/Analysis';
import Radar from './screens/Radar';

export default function App() {
  return (
    <HashRouter>
      <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden">

        {/* ── 全寬 Title Bar（三指拖動在此生效）── */}
        <div
          className="h-11 shrink-0 flex items-center bg-slate-900 border-b border-slate-800/60"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          {/* 左側留 80px 給紅黃綠按鈕 */}
          <span
            className="pl-20 text-xs font-semibold text-slate-500 tracking-widest uppercase select-none"
          >
            Stock Tracker
          </span>
        </div>

        {/* ── 主要內容區 ── */}
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-y-auto">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/holdings" element={<Holdings />} />
              <Route path="/transactions" element={<Transactions />} />
              <Route path="/analysis" element={<Analysis />} />
              <Route path="/radar" element={<Radar />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>

      </div>
    </HashRouter>
  );
}
