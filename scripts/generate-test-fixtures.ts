#!/usr/bin/env bun

/**
 * Generate test fixtures for document conversion tests.
 * Creates real PDF, DOCX, XLSX, PPTX files with known content.
 *
 * Run: bun scripts/generate-test-fixtures.ts
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from 'docx';
import ExcelJS from 'exceljs';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import PptxGenJS from 'pptxgenjs';

const FIXTURES_DIR = join(import.meta.dir, '../test/fixtures/conversion');

// ─────────────────────────────────────────────────────────────────────────────
// PDF Fixture
// ─────────────────────────────────────────────────────────────────────────────

async function generatePdf(): Promise<void> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.addPage([612, 792]); // Letter size
  const { height } = page.getSize();

  // Title
  page.drawText('GNO Test Document', {
    x: 50,
    y: height - 50,
    size: 24,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  // Subtitle
  page.drawText('PDF Conversion Test Fixture', {
    x: 50,
    y: height - 80,
    size: 14,
    font,
    color: rgb(0.3, 0.3, 0.3),
  });

  // Body content
  const bodyText = [
    'This document tests PDF-to-Markdown conversion.',
    '',
    'Key Features:',
    '• Text extraction from PDF pages',
    '• Handling of different font styles',
    '• Multi-line paragraph support',
    '',
    'The quick brown fox jumps over the lazy dog.',
    'Pack my box with five dozen liquor jugs.',
  ];

  let y = height - 120;
  for (const line of bodyText) {
    page.drawText(line, {
      x: 50,
      y,
      size: 12,
      font,
      color: rgb(0, 0, 0),
    });
    y -= 18;
  }

  const pdfBytes = await pdfDoc.save();
  await mkdir(join(FIXTURES_DIR, 'pdf'), { recursive: true });
  await writeFile(join(FIXTURES_DIR, 'pdf/sample.pdf'), pdfBytes);
  console.log('✓ Generated pdf/sample.pdf');
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCX Fixture
// ─────────────────────────────────────────────────────────────────────────────

async function generateDocx(): Promise<void> {
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            text: 'GNO Test Document',
            heading: HeadingLevel.HEADING_1,
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: 'This document tests DOCX-to-Markdown conversion.',
              }),
            ],
          }),
          new Paragraph({
            text: 'Features',
            heading: HeadingLevel.HEADING_2,
          }),
          new Paragraph({
            children: [
              new TextRun({ text: 'Bold text', bold: true }),
              new TextRun({ text: ' and ' }),
              new TextRun({ text: 'italic text', italics: true }),
              new TextRun({ text: ' are supported.' }),
            ],
          }),
          new Paragraph({
            text: 'Tables',
            heading: HeadingLevel.HEADING_2,
          }),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({
                    children: [new Paragraph('Name')],
                  }),
                  new TableCell({
                    children: [new Paragraph('Value')],
                  }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({
                    children: [new Paragraph('Alpha')],
                  }),
                  new TableCell({
                    children: [new Paragraph('100')],
                  }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({
                    children: [new Paragraph('Beta')],
                  }),
                  new TableCell({
                    children: [new Paragraph('200')],
                  }),
                ],
              }),
            ],
          }),
          new Paragraph({
            text: '',
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: 'The quick brown fox jumps over the lazy dog.',
              }),
            ],
          }),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  await mkdir(join(FIXTURES_DIR, 'docx'), { recursive: true });
  await writeFile(join(FIXTURES_DIR, 'docx/sample.docx'), buffer);
  console.log('✓ Generated docx/sample.docx');
}

// ─────────────────────────────────────────────────────────────────────────────
// XLSX Fixture
// ─────────────────────────────────────────────────────────────────────────────

async function generateXlsx(): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'GNO Test';
  workbook.created = new Date(2025, 0, 1);

  // Sheet 1: Sales Data
  const sheet1 = workbook.addWorksheet('Sales Data');
  sheet1.columns = [
    { header: 'Product', key: 'product', width: 20 },
    { header: 'Q1', key: 'q1', width: 10 },
    { header: 'Q2', key: 'q2', width: 10 },
    { header: 'Q3', key: 'q3', width: 10 },
    { header: 'Q4', key: 'q4', width: 10 },
    { header: 'Total', key: 'total', width: 12 },
  ];

  sheet1.addRows([
    { product: 'Widget A', q1: 100, q2: 150, q3: 200, q4: 180, total: 630 },
    { product: 'Widget B', q1: 80, q2: 90, q3: 110, q4: 120, total: 400 },
    { product: 'Gadget X', q1: 200, q2: 220, q3: 190, q4: 250, total: 860 },
  ]);

  // Sheet 2: Metadata
  const sheet2 = workbook.addWorksheet('Metadata');
  sheet2.addRows([
    ['Key', 'Value'],
    ['Version', '1.0'],
    ['Author', 'GNO Test Suite'],
    ['Purpose', 'XLSX conversion testing'],
  ]);

  await mkdir(join(FIXTURES_DIR, 'xlsx'), { recursive: true });
  await workbook.xlsx.writeFile(join(FIXTURES_DIR, 'xlsx/sample.xlsx'));
  console.log('✓ Generated xlsx/sample.xlsx');
}

// ─────────────────────────────────────────────────────────────────────────────
// PPTX Fixture
// ─────────────────────────────────────────────────────────────────────────────

async function generatePptx(): Promise<void> {
  const pptx = new PptxGenJS();
  pptx.author = 'GNO Test Suite';
  pptx.title = 'GNO Test Presentation';
  pptx.subject = 'PPTX Conversion Testing';

  // Slide 1: Title slide
  const slide1 = pptx.addSlide();
  slide1.addText('GNO Test Presentation', {
    x: 0.5,
    y: 2,
    w: '90%',
    h: 1,
    fontSize: 36,
    bold: true,
    align: 'center',
  });
  slide1.addText('Testing PPTX-to-Markdown Conversion', {
    x: 0.5,
    y: 3.2,
    w: '90%',
    h: 0.5,
    fontSize: 18,
    align: 'center',
    color: '666666',
  });

  // Slide 2: Content slide
  const slide2 = pptx.addSlide();
  slide2.addText('Key Features', {
    x: 0.5,
    y: 0.5,
    w: '90%',
    h: 0.8,
    fontSize: 28,
    bold: true,
  });
  slide2.addText(
    [
      { text: '• Text extraction from slides\n', options: { fontSize: 18 } },
      { text: '• Speaker notes support\n', options: { fontSize: 18 } },
      { text: '• Multiple slide handling\n', options: { fontSize: 18 } },
      { text: '• Table extraction\n', options: { fontSize: 18 } },
    ],
    { x: 0.5, y: 1.5, w: '90%', h: 2 }
  );
  slide2.addNotes(
    'These are speaker notes for slide 2. They should be extracted.'
  );

  // Slide 3: Table slide
  const slide3 = pptx.addSlide();
  slide3.addText('Data Table', {
    x: 0.5,
    y: 0.5,
    w: '90%',
    h: 0.8,
    fontSize: 28,
    bold: true,
  });
  slide3.addTable(
    [
      [
        { text: 'Item', options: { bold: true } },
        { text: 'Status', options: { bold: true } },
      ],
      [{ text: 'Feature A' }, { text: 'Complete' }],
      [{ text: 'Feature B' }, { text: 'In Progress' }],
      [{ text: 'Feature C' }, { text: 'Planned' }],
    ],
    { x: 0.5, y: 1.5, w: 6, colW: [3, 3] }
  );

  await mkdir(join(FIXTURES_DIR, 'pptx'), { recursive: true });
  await pptx.writeFile({ fileName: join(FIXTURES_DIR, 'pptx/sample.pptx') });
  console.log('✓ Generated pptx/sample.pptx');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Generating test fixtures...\n');

  await generatePdf();
  await generateDocx();
  await generateXlsx();
  await generatePptx();

  console.log('\n✓ All fixtures generated successfully');
}

main().catch((err) => {
  console.error('Failed to generate fixtures:', err);
  process.exit(1);
});
