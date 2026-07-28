import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

// PDF export: html2canvas + jsPDF, generated CLIENT-SIDE from the already
// rendered report, so the recharts SVGs appear exactly as they do on screen
// (rebuilding the layout server-side would mean re-implementing every chart).
//
// Pagination: the captured image is sliced across A4 pages, but the slice
// points are chosen to fall in the gaps BETWEEN blocks — elements marked
// data-pdf-block are never cut through the middle, so a chart can't be halved.

const A4 = { width: 210, height: 297 }; // mm, portrait
const MARGIN = 12;

function drawHeader(pdf, { title, range, generatedAt }) {
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(13);
  pdf.text('Barangay Ubujan, Tagbilaran City', A4.width / 2, MARGIN + 2, { align: 'center' });

  pdf.setFontSize(11);
  pdf.text(title, A4.width / 2, MARGIN + 9, { align: 'center' });

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  pdf.setTextColor(90);
  pdf.text(`Period covered: ${range.from} to ${range.to}`, A4.width / 2, MARGIN + 15, { align: 'center' });
  pdf.text(`Generated: ${generatedAt}`, A4.width / 2, MARGIN + 19.5, { align: 'center' });
  pdf.setTextColor(0);
  pdf.setDrawColor(200);
  pdf.line(MARGIN, MARGIN + 22.5, A4.width - MARGIN, MARGIN + 22.5);

  return MARGIN + 26; // y where content may start on page 1
}

function drawFooter(pdf, page, pageCount) {
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(120);
  pdf.text(`Page ${page} of ${pageCount}`, A4.width / 2, A4.height - 7, { align: 'center' });
  pdf.text('BrgyServe', MARGIN, A4.height - 7);
  pdf.setTextColor(0);
}

/**
 * Render a DOM node to a paginated A4 PDF and trigger a download.
 *
 * @param {HTMLElement} node   the report container to capture
 * @param {object} opts        { title, range: {from,to}, filenameBase }
 */
export async function exportReportPdf(node, { title, range, filenameBase }) {
  const canvas = await html2canvas(node, {
    scale: 2, // sharper text and chart lines
    backgroundColor: '#ffffff',
    useCORS: true,
    logging: false,
  });

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const generatedAt = new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });

  const contentWidth = A4.width - MARGIN * 2;
  const pxPerMm = canvas.width / contentWidth; // canvas pixels per mm of PDF
  const firstPageTop = MARGIN + 26; // room for the header block
  const laterPageTop = MARGIN + 6;
  const pageBottom = A4.height - MARGIN - 6; // room for the footer

  // Candidate cut points (in canvas px) at the END of each block, so slices
  // land between blocks rather than through a chart.
  const nodeRect = node.getBoundingClientRect();
  const blockEnds = Array.from(node.querySelectorAll('[data-pdf-block]'))
    .map((el) => (el.getBoundingClientRect().bottom - nodeRect.top) * (canvas.height / node.offsetHeight))
    .sort((a, b) => a - b);

  const slices = [];
  let offset = 0;
  let isFirst = true;
  while (offset < canvas.height - 1) {
    const availableMm = pageBottom - (isFirst ? firstPageTop : laterPageTop);
    const maxPx = availableMm * pxPerMm;
    let end = Math.min(canvas.height, offset + maxPx);

    if (end < canvas.height) {
      // pull back to the last block boundary that fits, if there is one
      const fits = blockEnds.filter((b) => b > offset + maxPx * 0.25 && b <= end);
      if (fits.length) end = fits[fits.length - 1];
    }
    slices.push({ start: offset, end, top: isFirst ? firstPageTop : laterPageTop });
    offset = end;
    isFirst = false;
  }

  slices.forEach((slice, i) => {
    if (i > 0) pdf.addPage();
    if (i === 0) drawHeader(pdf, { title, range, generatedAt });

    const sliceHeight = slice.end - slice.start;
    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = canvas.width;
    pageCanvas.height = sliceHeight;
    const ctx = pageCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    ctx.drawImage(canvas, 0, slice.start, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);

    pdf.addImage(
      pageCanvas.toDataURL('image/png'),
      'PNG',
      MARGIN,
      slice.top,
      contentWidth,
      sliceHeight / pxPerMm
    );
  });

  const total = pdf.getNumberOfPages();
  for (let p = 1; p <= total; p += 1) {
    pdf.setPage(p);
    drawFooter(pdf, p, total);
  }

  pdf.save(`${filenameBase}-${range.from}-to-${range.to}.pdf`);
}
