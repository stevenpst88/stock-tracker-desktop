import { NavLink } from 'react-router-dom';
import clsx from 'clsx';

const links = [
  { to: '/',             label: '總覽',     icon: '◈' },
  { to: '/holdings',    label: '持倉',     icon: '⊞' },
  { to: '/transactions',label: '交易紀錄', icon: '≡' },
  { to: '/analysis',    label: '分析',     icon: '◉' },
  { to: '/radar',       label: '雷達',     icon: '⊕' },
];

export default function Sidebar() {
  return (
    <aside className="w-52 flex flex-col bg-slate-900 border-r border-slate-800 shrink-0">
      <nav className="flex-1 px-2 py-2 space-y-1">
        {links.map(l => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.to === '/'}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                isActive
                  ? 'bg-blue-600 text-white font-medium'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
              )
            }
          >
            <span className="text-base leading-none">{l.icon}</span>
            {l.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
