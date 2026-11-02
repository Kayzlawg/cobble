import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "./Icon";
import logo from "./logo.png";

export default function TitleBar() {
  const win = getCurrentWindow();
  const [max, setMax] = useState(false);

  useEffect(() => {
    const sync = () => win.isMaximized().then(setMax);
    sync();
    const off = win.onResized(sync);
    return () => {
      off.then((f) => f());
    };
  }, [win]);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <img src={logo} alt="" width={16} height={16} />
      <span>Cobble</span>
      <div className="ctl">
        <button aria-label="Minimize" onClick={() => win.minimize()}>
          <Icon name="minus" size={14} />
        </button>
        <button aria-label={max ? "Restore" : "Maximize"} onClick={() => win.toggleMaximize()}>
          <Icon name={max ? "restore" : "square"} size={12} />
        </button>
        <button className="close" aria-label="Close" onClick={() => win.close()}>
          <Icon name="x" size={14} />
        </button>
      </div>
    </header>
  );
}
