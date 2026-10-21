export interface BoqImportCell { text: string; kind: 'text' | 'number' | 'blank' | 'boolean' | 'error'; formula?: string; merged?: boolean }
export interface BoqImportRow { number: number; cells: BoqImportCell[] }
export interface BoqImportSheet { id: string; name: string; hidden: boolean; rows: BoqImportRow[] }
export interface BoqImportFile { format: 'xlsx' | 'csv'; sheets: BoqImportSheet[]; warnings: string[] }
export interface BoqImportEditLine { id?: string; code: string; name: string; location: string; unit: string; quantity: string; unitPrice: string }
export interface BoqImportLockedLine { id: string; code: string; name: string; location: string; unit: string; quantity: number; unitPrice: number; amount?: number }
export interface BoqImportUsedLine { id: string; usedQuantity: number; usedAmount: number }
export type BoqImportField = 'id' | 'code' | 'name' | 'location' | 'unit' | 'quantity' | 'unitPrice';
export type BoqImportMapping = Record<BoqImportField, number>;
export interface BoqImportError { row: number; field: string; message: string }
export interface BoqImportPreview {
  allowed: boolean;
  rows: { sourceRow: number; action: 'new' | 'matched' | 'invalid'; line: BoqImportEditLine | null; amount: number | null; errors: BoqImportError[] }[];
  errors: BoqImportError[];
  warnings: string[];
  lines: BoqImportEditLine[];
  summary: { rowCount: number; newCount: number; matchedCount: number; removedDraftCount: number; totalAmount: number; deltaAmount: number };
}
export const BOQ_IMPORT_LIMITS: Readonly<{ fileBytes: number; inflatedBytes: number; sheets: number; rows: number; columns: number; cells: number; lines: number }>;
export function readBoqImportFile(bytes: Uint8Array | ArrayBuffer, options: { filename: string; encoding?: string; parseXml?: (xml: string) => Document }): BoqImportFile;
export function inferBoqImportMapping(sheet: BoqImportSheet, headerRow: number): BoqImportMapping;
export function previewBoqImport(options: { sheet: BoqImportSheet; headerRow: number; startRow?: number; endRow?: number; mapping: BoqImportMapping; existingLines: BoqImportEditLine[]; lockedLines: BoqImportLockedLine[]; usedLines: BoqImportUsedLine[]; effectiveAmount: number; isInitial: boolean }): BoqImportPreview;
