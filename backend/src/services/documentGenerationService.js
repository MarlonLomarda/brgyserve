const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

const { getDocumentTemplate } = require("./documentTemplateService.js");

const generateDocx = async (templatePath, data) => {
  // get the template file from supabase storage and return as node.js buffer
  const templateBuffer = await getDocumentTemplate(templatePath);

  // upload the template buffer to pizzip so we can use it with docxtamplater
  const zip = new PizZip(templateBuffer);

  // initialize docxtamplater using the template
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
  });

  // replace the templates placeholder with the actual data
  doc.render(data);

  // then, generate completed document as a node.js buffer
  const outputBuffer = doc.toBuffer();

  return outputBuffer;
};

module.exports = { generateDocx };
