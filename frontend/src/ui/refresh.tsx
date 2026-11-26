// "Refresh" button for pages that people keep open (seller and admin orders): fetches the latest
// data without blanking the page, then shows when it was last updated.
import { useEffect, useState } from "react";
import { LuRefreshCw } from "react-icons/lu";
import { errorMessage } from "../lib/api";
import { useToast } from "../state/app";
import { Button } from "./core";

const timeFmt = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" });

export function RefreshButton({ onRefresh }: { onRefresh: () => Promise<unknown> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState(() => new Date());
  const [, setNow] = useState(0);
  // Re-render each minute so "Updated" stays honest while the page sits open.
  useEffect(() => {
    const id = window.setInterval(() => setNow((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const refresh = async () => {
    setBusy(true);
    try {
      await onRefresh();
      setUpdated(new Date());
    } catch (err) {
      toast(errorMessage(err), "bad");
    } finally { setBusy(false); }
  };
  return (
    <div className="refresh">
      <span className="small muted refresh__time">Updated {timeFmt.format(updated)}</span>
      <Button size="sm" icon={LuRefreshCw} busy={busy} onClick={() => void refresh()}>Refresh</Button>
    </div>
  );
}
