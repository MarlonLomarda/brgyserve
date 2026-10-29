const supabase = require("../config/supabase");

const { generateDocx } = require("../services/documentGenerationService.js");
const {
  convertDocxToPdf,
} = require("../services/documentConversionService.js");

const previewPdf = async (req, res) => {
  try {
    // document request id
    const { id } = req.params;

    // retreive document request and resident datas from supabase
    const { data, error } = await supabase
      .from("document_requests")
      .select(
        `
        *, document_types (template_path), resident_records (*)`,
      )
      .eq("request_id", id)
      .single();

    if (error) throw new Error(`Failed to retreive document request.`);
    if (!data) throw new Error(`Document request with ID ${id} is not found.`);

    const { template_path } = data.document_types;

    // generate .docx file with the resident's information filled in
    const docxBuffer = await generateDocx(template_path, data.resident_records);

    // convert the .docx file into a .pdf
    const pdfBuffer = await convertDocxToPdf(docxBuffer);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="document-preview.pdf"',
    );

    return res.status(200).send(pdfBuffer);
  } catch (error) {
    console.error("Document preview error:", error);

    return res
      .status(500)
      .json({ success: false, message: "Failed to generate document preview" });
  }
};

module.exports = { previewPdf };
