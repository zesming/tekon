import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvidenceItem, ProjectRun } from "./types.js";
import { ensureDir, relativePath } from "./fs-store.js";
import { renderEvidenceHtml } from "./html.js";

export async function writeTextEvidence(options: {
  workspaceRoot: string;
  outputDir: string;
  type: EvidenceItem["type"];
  title: string;
  fileName: string;
  content: string;
  summary: string;
}): Promise<EvidenceItem> {
  const evidenceDir = path.join(options.outputDir, "evidence");
  await ensureDir(evidenceDir);
  const filePath = path.join(evidenceDir, options.fileName);
  await writeFile(filePath, options.content, "utf8");
  return {
    id: `${options.type}-${Date.now()}`,
    type: options.type,
    title: options.title,
    path: relativePath(options.workspaceRoot, filePath),
    summary: options.summary,
  };
}

export async function writeHtmlReport(run: ProjectRun, workspaceRoot: string): Promise<EvidenceItem> {
  const reportPath = path.join(run.outputDir, "report.html");
  const htmlEvidence: EvidenceItem = {
    id: `html-${Date.now()}`,
    type: "html_report",
    title: "HTML 交付证据包",
    path: relativePath(workspaceRoot, reportPath),
    summary: "面向人类审阅的交付证据包",
  };
  await writeFile(reportPath, renderEvidenceHtml({ ...run, evidence: [...run.evidence, htmlEvidence] }), "utf8");
  return htmlEvidence;
}
