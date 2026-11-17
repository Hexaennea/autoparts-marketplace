import { useRef, useState } from "react";
import { LuDownload, LuFileCheck, LuFileSpreadsheet, LuUpload } from "react-icons/lu";
import { api, errorMessage } from "../../lib/api";
import { invalidate } from "../../lib/query";
import { useToast } from "../../state/app";
import { Alert, Button, Card, PageHeader } from "../../ui/core";

interface Report {
  ok: boolean; dry_run: boolean; errors: { row: number; field: string; message: string }[]; error_count: number;
  rows: number; new: number; updates: number; created?: number; updated?: number;
}

export function ImportPage() {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState<"" | "check" | "apply">("");

  const run = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(dryRun ? "check" : "apply");
    try {
      const r = await api.upload<Report>("/api/seller/import", file, { dry_run: dryRun ? "true" : "false" });
      setReport(r);
      if (!dryRun && r.ok) {
        invalidate("/api/seller/");
        toast(`Imported: ${r.created ?? 0} new drafts, ${r.updated ?? 0} updated.`);
      }
    } catch (err) {
      toast(errorMessage(err), "bad");
    } finally { setBusy(""); }
  };

  return (
    <>
      <PageHeader title="Bulk import" subtitle="Create drafts or update price and stock for many listings from one CSV file." />
      <div className="import-steps">
        <Card pad>
          <div className="stack" style={{ "--gap": "10px" }}>
            <div className="micro">Step 1</div>
            <h3>Download the template</h3>
            <p className="small muted">One row per listing. Vehicle codes link a row to exact variants; the codes file lists every code, category and brand.</p>
            <div className="row row--wrap">
              <a className="btn btn--secondary btn--sm" href="/api/seller/import/template.csv" download><LuDownload aria-hidden="true" /> Template</a>
              <a className="btn btn--secondary btn--sm" href="/api/seller/import/reference.csv" download><LuDownload aria-hidden="true" /> Codes reference</a>
            </div>
          </div>
        </Card>
        <Card pad>
          <div className="stack" style={{ "--gap": "10px" }}>
            <div className="micro">Step 2</div>
            <h3>Choose your file</h3>
            <p className="small muted">UTF-8 CSV, up to 500 rows and 1 MB. Existing SKUs are updated; new SKUs become drafts.</p>
            <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => { setFile(e.target.files?.[0] ?? null); setReport(null); e.target.value = ""; }} />
            <div className="row row--wrap"><Button icon={LuFileSpreadsheet} size="sm" onClick={() => input.current?.click()}>{file ? "Choose another file" : "Choose CSV"}</Button>{file && <span className="small strong">{file.name}</span>}</div>
          </div>
        </Card>
        <Card pad>
          <div className="stack" style={{ "--gap": "10px" }}>
            <div className="micro">Step 3</div>
            <h3>Check, then import</h3>
            <p className="small muted">Checking validates every row without saving. Nothing is imported unless the whole file is valid.</p>
            <div className="row row--wrap">
              <Button icon={LuFileCheck} size="sm" disabled={!file} busy={busy === "check"} onClick={() => void run(true)}>Check file</Button>
              <Button icon={LuUpload} size="sm" variant="primary" disabled={!file || !report?.ok || !report.dry_run} busy={busy === "apply"} onClick={() => void run(false)}>Import</Button>
            </div>
          </div>
        </Card>
      </div>

      {report && (
        <div style={{ marginTop: 20 }} className="stack">
          {report.ok && report.dry_run && <Alert kind="ok" title="Ready to import">{report.rows} rows checked: {report.new} new listings, {report.updates} updates.</Alert>}
          {report.ok && !report.dry_run && <Alert kind="ok" title="Import complete">{report.created} new drafts created and {report.updated} listings updated. Add photos to drafts, then submit them for review.</Alert>}
          {!report.ok && (
            <Card title={`${report.error_count} problem${report.error_count === 1 ? "" : "s"} to fix`}>
              <div className="table-wrap" style={{ maxHeight: 420 }}>
                <table className="table">
                  <thead><tr><th>Row</th><th>Column</th><th>Problem</th></tr></thead>
                  <tbody>{report.errors.map((e, i) => <tr key={i}><td className="strong">{e.row || "—"}</td><td className="pn">{e.field}</td><td>{e.message}</td></tr>)}</tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
