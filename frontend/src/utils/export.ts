import type { AnalysisResult } from '../types';

/** Format an AnalysisResult as a Markdown document */
export function resultToMarkdown(fileName: string, result: AnalysisResult): string {
  const lines: string[] = [];

  lines.push(`# Analysis: ${fileName}`);
  lines.push('');

  if (result.summary) {
    lines.push('## Summary');
    lines.push('');
    lines.push(result.summary);
    lines.push('');
  }

  if (result.description) {
    lines.push('## Description');
    lines.push('');
    lines.push(result.description);
    lines.push('');
  }

  if (result.insights?.length) {
    lines.push('## Insights');
    lines.push('');
    result.insights.forEach((ins) => lines.push(`- ${ins}`));
    lines.push('');
  }

  if (result.observations?.length) {
    lines.push('## Observations');
    lines.push('');
    result.observations.forEach((obs) => lines.push(`- ${obs}`));
    lines.push('');
  }

  if (result.contentClassification) {
    lines.push(`**Content Classification:** ${result.contentClassification}`);
    lines.push('');
  }

  if (result.ocrText && result.ocrText !== 'No text detected.') {
    lines.push('## Extracted Text (OCR)');
    lines.push('');
    lines.push('```');
    lines.push(result.ocrText);
    lines.push('```');
    lines.push('');
  }

  if (result.chainOfThought) {
    lines.push('<details>');
    lines.push('<summary>Chain of Thought</summary>');
    lines.push('');
    lines.push(result.chainOfThought);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Metadata
  lines.push('---');
  lines.push(`*Mode: ${result.mode ?? 'fast'} · Model: ${result.model ?? 'unknown'} · Provider: ${result.provider ?? 'unknown'}*`);
  if (result.processingTimeMs) {
    lines.push(`*Processing time: ${(result.processingTimeMs / 1000).toFixed(1)}s*`);
  }
  if (result.usage) {
    lines.push(`*Tokens: ${result.usage.inputTokens ?? 0} input / ${result.usage.outputTokens ?? 0} output*`);
  }
  lines.push('');

  return lines.join('\n');
}

/** Trigger a file download in the browser */
export function downloadText(content: string, filename: string, mimeType = 'text/markdown') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
