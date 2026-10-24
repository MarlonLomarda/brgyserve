const supabase = require("../config/supabase.js");

const STORAGE = "document-templates";

const getDocumentTemplate = async (templatePath) => {
  // Get the document template stored in Supabase Storage using its file path
  const { data, error } = await supabase.storage
    .from(STORAGE)
    .download(templatePath);

  if (error) throw new Error(`Failed to download template: ${error.message}`);

  if (!data) throw new Error("Template file was not returned");

  // Return the document template as a Node.js Buffer
  return Buffer.from(await data.arrayBuffer());
};

module.exports = { getDocumentTemplate };
