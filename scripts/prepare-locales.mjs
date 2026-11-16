import fs from "node:fs";
const locales = fs.readdirSync("addon/locale", { withFileTypes: true }).filter(entry => entry.isDirectory()
  && fs.existsSync(`addon/locale/${entry.name}/knowledgemcp.ftl`)).map(entry => entry.name).sort();
if (!locales.includes("en-US")) throw Error("English source locale is required");
fs.writeFileSync("addon/content/locale-catalog.json", JSON.stringify(locales, null, 2) + "\n");
