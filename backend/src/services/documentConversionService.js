const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const convertDocxToPdf = async (docxBuffer) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "brgyserve-"));

  const docxPath = path.join(tempDir, "document.docx");
  const pdfPath = path.join(tempDir, "document.pdf");

  try {
    await fs.writeFile(docxPath, docxBuffer);

    await execFileAsync("libreoffice", [
      "--headless",
      "--convert-to",
      "pdf",
      "--outdir",
      tempDir,
      docxPath,
    ]);

    return await fs.readFile(pdfPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

module.exports = { convertDocxToPdf };
