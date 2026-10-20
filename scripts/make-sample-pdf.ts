// Generates docs/pourwell-kettle-quickstart.pdf, the PDF in the demo knowledge base.
// The PDF is committed; run `npm run make:pdf` only if you change the text below.
import { writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";

const pages: { heading: string; paragraphs: string[] }[] = [
  {
    heading: "Pourwell kettle: quick start",
    paragraphs: [
      "The Pourwell is a 0.9-litre gooseneck kettle for pour-over coffee. Rinse it twice with fresh water before the first use.",
      "Temperature: set any temperature from 40 to 100 degrees Celsius in 1-degree steps. For light roasts we suggest 96 degrees, for dark roasts 88 degrees.",
      "Hold mode: press the clock button to keep the water at the set temperature for up to 60 minutes. The kettle switches off by itself after 60 minutes or when lifted off the base for more than 2 minutes.",
    ],
  },
  {
    heading: "Pourwell kettle: care and safety",
    paragraphs: [
      "Never put the kettle or its base in water or in the dishwasher. Wipe the outside with a damp cloth.",
      "Descale the Pourwell kettle once a month with citric acid: fill it halfway with water and one tablespoon of citric acid, heat to 90 degrees, leave it for 15 minutes, then rinse twice.",
      "If the display shows 'dry', the kettle was switched on without water. Let it cool for 10 minutes before refilling.",
    ],
  },
];

const pdf = await PDFDocument.create();
pdf.setTitle("Pourwell kettle quick start");
const font = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

for (const { heading, paragraphs } of pages) {
  const page = pdf.addPage([595, 842]);
  let y = 780;
  page.drawText(heading, { x: 50, y, size: 18, font: bold });
  y -= 36;
  for (const text of paragraphs) {
    // Simple word wrap at ~90 characters per line.
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(" ")) {
      if ((line + " " + word).trim().length > 90) {
        lines.push(line);
        line = word;
      } else line = (line + " " + word).trim();
    }
    lines.push(line);
    for (const l of lines) {
      page.drawText(l, { x: 50, y, size: 11, font });
      y -= 16;
    }
    y -= 12;
  }
}

await writeFile("docs/pourwell-kettle-quickstart.pdf", await pdf.save());
console.log("wrote docs/pourwell-kettle-quickstart.pdf");
