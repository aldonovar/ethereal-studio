import React from 'react';
import { Minus, Square, X } from 'lucide-react';
import AppLogo from '../AppLogo';
import { platformService } from '../../services/platformService';

type AppRegionStyle = React.CSSProperties & {
  WebkitAppRegion: 'drag' | 'no-drag';
};

export function DesktopWindowChrome() {
  return (
    <div className="desktop-titlebar">
      <div className="desktop-titlebar__brand" style={{ WebkitAppRegion: 'drag' } as AppRegionStyle}>
        <AppLogo size={20} />
        <span className="desktop-titlebar__label">DAW-fi</span>
      </div>
      <div className="desktop-titlebar__actions" style={{ WebkitAppRegion: 'no-drag' } as AppRegionStyle}>
        <button className="desktop-window-btn" onClick={() => platformService.minimize()} title="Minimizar">
          <Minus size={14} />
        </button>
        <button className="desktop-window-btn" onClick={() => platformService.maximize()} title="Maximizar">
          <Square size={12} />
        </button>
        <button className="desktop-window-btn desktop-window-btn--danger" onClick={() => platformService.close()} title="Cerrar">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
