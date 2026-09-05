'use strict';

const mime = require('mime-types');
const path = require('path');
const fs = require('fs');
const jsdom = require('jsdom');
const TurndownService = require('turndown');
const turndownPluginGfm = require('@joplin/turndown-plugin-gfm');
const xmldom = require('@xmldom/xmldom');
const url = require('url');
const pdfParse = require('pdf-parse');
const Mammoth = require('mammoth');
const XLSX = require('xlsx');
const childProcess = require('child_process');
const util = require('util');
const fs$1 = require('fs/promises');
const os = require('os');
const ai = require('ai');
const stream = require('stream');

function _interopDefaultCompat (e) { return e && typeof e === 'object' && 'default' in e ? e.default : e; }

function _interopNamespaceCompat(e) {
  if (e && typeof e === 'object' && 'default' in e) return e;
  const n = Object.create(null);
  if (e) {
    for (const k in e) {
      n[k] = e[k];
    }
  }
  n.default = e;
  return n;
}

const mime__namespace = /*#__PURE__*/_interopNamespaceCompat(mime);
const path__namespace = /*#__PURE__*/_interopNamespaceCompat(path);
const path__default = /*#__PURE__*/_interopDefaultCompat(path);
const fs__default = /*#__PURE__*/_interopDefaultCompat(fs);
const fs__namespace = /*#__PURE__*/_interopNamespaceCompat(fs);
const TurndownService__default = /*#__PURE__*/_interopDefaultCompat(TurndownService);
const turndownPluginGfm__default = /*#__PURE__*/_interopDefaultCompat(turndownPluginGfm);
const Mammoth__default = /*#__PURE__*/_interopDefaultCompat(Mammoth);
const XLSX__namespace = /*#__PURE__*/_interopNamespaceCompat(XLSX);
const childProcess__namespace = /*#__PURE__*/_interopNamespaceCompat(childProcess);
const util__namespace = /*#__PURE__*/_interopNamespaceCompat(util);
const fs__namespace$1 = /*#__PURE__*/_interopNamespaceCompat(fs$1);
const os__namespace = /*#__PURE__*/_interopNamespaceCompat(os);

class PlainTextConverter {
  async convert(source, options = {}) {
    const fileExtension = options.file_extension || "";
    const contentType = mime__namespace.lookup(fileExtension);
    if (!contentType) {
      return null;
    } else if (!contentType.toLowerCase().includes("text/")) {
      return null;
    }
    let content;
    if (typeof source === "string") {
      content = fs__default.readFileSync(source, { encoding: "utf-8" });
    } else {
      content = Buffer.from(source).toString("utf-8");
    }
    return {
      title: null,
      markdown: content,
      text_content: content
    };
  }
}

class CustomTurnDown {
  convert_soup(doc) {
    let turnDownService = new TurndownService__default({
      headingStyle: "atx"
    });
    turnDownService.use(turndownPluginGfm__default.gfm);
    turnDownService.addRule("anchor tags", {
      filter: ["a"],
      replacement: function(content, node) {
        if (content === "") {
          return "";
        }
        let prefix = "";
        let suffix = "";
        if (content && content[0] === " ") {
          prefix = " ";
        }
        if (content && content[content.length - 1] === " ") {
          suffix = " ";
        }
        let text = content.trim().replace(/\n\n.*/g, "");
        if (text === "") {
          return "";
        }
        let href = node.getAttribute("href");
        let title = node.title;
        if (href) {
          try {
            let parsed_url = new URL(href);
            if (!["https:", "http:", "file:"].includes(parsed_url.protocol)) {
              return `${prefix}${text}${suffix}`;
            }
          } catch (e) {
            if (!/^https?:|^file:/.test(href)) {
              return `${prefix}[${text}](${href} "${title}")${suffix}`;
            }
            return `${prefix}${text}${suffix}`;
          }
        }
        if (text.replace(/\\_/g, "_") === href && !title) {
          return `<${href}>`;
        }
        if (!title && href) {
          title = href;
        }
        let title_part = title ? ` "${title}"` : "";
        return `${prefix}[${text}](${href}${title_part})${suffix}`;
      }
    });
    turnDownService.addRule("img tags", {
      filter: ["img"],
      replacement: function(_, node) {
        if (!node || node.nodeName !== "IMG") {
          return "";
        }
        let alt = node.getAttribute("alt") || "";
        let src = node.getAttribute("src") || "";
        let title = node.getAttribute("title") || "";
        let titlePart = title ? ` "${title}"` : "";
        if (src.startsWith("data:")) {
          src = src.split(",")[0] + "...";
        }
        return `![${alt}](${src}${titlePart})`;
      }
    });
    let markdown = turnDownService.turndown(doc);
    return markdown;
  }
}

class HtmlConverter {
  async convert(source, options) {
    const extension = options.file_extension || "";
    if (![".html", ".htm"].includes(extension.toLowerCase())) {
      return null;
    }
    try {
      let content;
      if (typeof source === "string") {
        let exists = fs__namespace.existsSync(source);
        if (!exists) {
          throw new Error("File does'nt exists");
        }
        content = fs__namespace.readFileSync(source, { encoding: "utf-8" });
      } else {
        content = source.toString("utf-8");
      }
      return await this._convert(content);
    } catch (e) {
      console.error(e);
      return null;
    }
  }
  async _convert(htmlContent) {
    const soup = new jsdom.JSDOM(htmlContent);
    const doc = soup.window.document;
    doc.querySelectorAll("script, style").forEach((script) => {
      script.remove();
    });
    const bodyElm = doc.querySelector("body");
    let webpageText = "";
    if (bodyElm) {
      webpageText = new CustomTurnDown().convert_soup(bodyElm);
    } else {
      webpageText = new CustomTurnDown().convert_soup(doc);
    }
    return {
      title: doc.title,
      markdown: webpageText,
      text_content: webpageText
    };
  }
}

class RSSConverter {
  async convert(source, options = {}) {
    const fileExtension = options.file_extension || "";
    if (![".xml", ".rss", ".atom"].includes(fileExtension.toLowerCase())) {
      return null;
    }
    try {
      const xmlString = typeof source === "string" ? fs__namespace.readFileSync(source, { encoding: "utf-8" }) : source.toString("utf-8");
      const doc = new xmldom.DOMParser().parseFromString(xmlString, "text/xml");
      let result;
      if (doc.getElementsByTagName("rss").length > 0) {
        result = this._parseRssType(doc);
      } else if (doc.getElementsByTagName("feed").length > 0) {
        const root = doc.getElementsByTagName("feed")[0];
        if (root.getElementsByTagName("entry").length > 0) {
          result = this._parseAtomType(doc);
        }
      }
      return result;
    } catch (error) {
      console.error("RSS Parsing Error:", error);
      return null;
    }
  }
  _parseAtomType(doc) {
    try {
      const root = doc.getElementsByTagName("feed")[0];
      const title = this._getDataByTagName(root, "title");
      const subtitle = this._getDataByTagName(root, "subtitle");
      const entries = root.getElementsByTagName("entry");
      let mdText = `# ${title}
`;
      if (subtitle) {
        mdText += `${subtitle}
`;
      }
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const entryTitle = this._getDataByTagName(entry, "title");
        const entrySummary = this._getDataByTagName(entry, "summary");
        const entryUpdated = this._getDataByTagName(entry, "updated");
        const entryContent = this._getDataByTagName(entry, "content");
        if (entryTitle) {
          mdText += `
## ${entryTitle}
`;
        }
        if (entryUpdated) {
          mdText += `Updated on: ${entryUpdated}
`;
        }
        if (entrySummary) {
          mdText += this._parseContent(entrySummary);
        }
        if (entryContent) {
          mdText += this._parseContent(entryContent);
        }
      }
      return { title, markdown: mdText, text_content: mdText };
    } catch (error) {
      console.error("Atom Parsing Error:", error);
      return null;
    }
  }
  _parseRssType(doc) {
    try {
      const root = doc.getElementsByTagName("rss")[0];
      const channel = root.getElementsByTagName("channel");
      if (!channel || channel.length === 0) {
        return null;
      }
      const channelElement = channel[0];
      const channelTitle = this._getDataByTagName(channelElement, "title");
      const channelDescription = this._getDataByTagName(channelElement, "description");
      const items = channelElement.getElementsByTagName("item");
      let mdText = "";
      if (channelTitle) {
        mdText = `# ${channelTitle}
`;
      }
      if (channelDescription) {
        mdText += `${channelDescription}
`;
      }
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const title = this._getDataByTagName(item, "title");
        const description = this._getDataByTagName(item, "description");
        const pubDate = this._getDataByTagName(item, "pubDate");
        const content = this._getDataByTagName(item, "content:encoded");
        if (title) {
          mdText += `
## ${title}
`;
        }
        if (pubDate) {
          mdText += `Published on: ${pubDate}
`;
        }
        if (description) {
          mdText += this._parseContent(description);
        }
        if (content) {
          mdText += this._parseContent(content);
        }
      }
      return { title: channelTitle, markdown: mdText, text_content: mdText };
    } catch (error) {
      console.error("RSS Parsing Error:", error);
      return null;
    }
  }
  _parseContent(content) {
    try {
      const dom = new jsdom.JSDOM(content);
      const document = dom.window.document;
      return new CustomTurnDown().convert_soup(document);
    } catch (error) {
      console.warn("Parsing content error", error);
      return content;
    }
  }
  _getDataByTagName(element, tagName) {
    const nodes = element.getElementsByTagName(tagName);
    if (!nodes || nodes.length === 0) {
      return null;
    }
    const fc = nodes[0].firstChild;
    if (fc && fc.nodeValue) {
      return fc.nodeValue;
    }
    return null;
  }
}

const WIKIPEDIA_REGEX = /^https?:\/\/[a-zA-Z]{2,3}\.wikipedia\.org\//;
const BODY_SELECTOR_QUERY = "div#mw-content-text";
const TITLE_SELECTOR_QUERY = "span.mw-page-title-main";
class WikipediaConverter {
  async convert(source, options = {}) {
    const fileExtension = options.file_extension || "";
    if (![".html", ".htm"].includes(fileExtension.toLowerCase())) {
      return null;
    }
    const url = options.url || "";
    if (!WIKIPEDIA_REGEX.test(url)) {
      return null;
    }
    try {
      const htmlContent = typeof source === "string" ? fs__namespace.readFileSync(source, { encoding: "utf-8" }) : source.toString("utf-8");
      return this._convert(htmlContent);
    } catch (error) {
      console.error("Wikipedia Parsing Error:", error);
      return null;
    }
  }
  _convert(htmlContent) {
    const dom = new jsdom.JSDOM(htmlContent);
    const doc = dom.window.document;
    doc.querySelectorAll("script, style").forEach((script) => {
      script.remove();
    });
    const bodyElm = doc.querySelector(BODY_SELECTOR_QUERY);
    const titleElm = doc.querySelector(TITLE_SELECTOR_QUERY);
    let webpageText = "";
    let mainTitle = doc.title;
    if (bodyElm) {
      if (titleElm && titleElm.textContent) {
        mainTitle = titleElm.textContent;
      }
      webpageText = `# ${mainTitle}

` + new CustomTurnDown().convert_soup(bodyElm);
    } else {
      webpageText = new CustomTurnDown().convert_soup(doc);
    }
    return { title: mainTitle, markdown: webpageText, text_content: webpageText };
  }
}

class YouTubeConverter {
  async convert(source, options = {}) {
    const fileExtension = options.file_extension || "";
    if (![".html", ".htm"].includes(fileExtension.toLowerCase())) {
      return null;
    }
    const url = options.url || "";
    if (!url.startsWith("https://www.youtube.com/watch?")) {
      return null;
    }
    try {
      const htmlContent = typeof source === "string" ? fs__namespace.readFileSync(source, { encoding: "utf-8" }) : source.toString("utf-8");
      return this._convert(htmlContent, url, options);
    } catch (error) {
      console.error("YouTube Parsing Error:", error);
      return null;
    }
  }
  async _convert(htmlContent, url$1, options) {
    const dom = new jsdom.JSDOM(htmlContent);
    const doc = dom.window.document;
    const metadata = {
      title: doc.title
    };
    doc.querySelectorAll("meta").forEach((meta) => {
      for (const a of meta.attributes) {
        const attributeContent = meta.getAttribute("content");
        if (["itemprop", "property", "name"].includes(a.name) && attributeContent) {
          metadata[a.value] = attributeContent;
          break;
        }
      }
    });
    try {
      for (const script of doc.querySelectorAll("script")) {
        const content = script.textContent || "";
        if (content.includes("ytInitialData")) {
          const lines = content.split(/\r?\n/);
          const objStart = lines[0].indexOf("{");
          const objEnd = lines[0].lastIndexOf("}");
          if (objStart >= 0 && objEnd >= 0) {
            const data = JSON.parse(lines[0].substring(objStart, objEnd + 1));
            const attrdesc = this._findKey(data, "attributedDescriptionBodyText");
            if (attrdesc) {
              metadata["description"] = attrdesc["content"];
            }
          }
          break;
        }
      }
    } catch (e) {
      console.warn("Error while parsing Youtube description");
    }
    let webpageText = "# YouTube\n";
    const title = this._get(metadata, ["title", "og:title", "name"]);
    if (title) {
      webpageText += `
## ${title}
`;
    }
    let stats = "";
    const views = this._get(metadata, ["interactionCount"]);
    if (views) {
      stats += `- **Views:** ${views}
`;
    }
    const keywords = this._get(metadata, ["keywords"]);
    if (keywords) {
      stats += `- **Keywords:** ${keywords}
`;
    }
    const runtime = this._get(metadata, ["duration"]);
    if (runtime) {
      stats += `- **Runtime:** ${runtime}
`;
    }
    if (stats.length > 0) {
      webpageText += `
### Video Metadata
${stats}
`;
    }
    const description = this._get(metadata, ["description", "og:description"]);
    if (description) {
      webpageText += `
### Description
${description}
`;
    }
    if (options.enableYoutubeTranscript) {
      let transcriptText = "";
      const parsedUrl = new url.URL(url$1);
      const params = parsedUrl.searchParams;
      const videoId = params.get("v");
      let ytTranscript;
      try {
        ytTranscript = await import('youtube-transcript').then((mod) => mod.YoutubeTranscript);
      } catch (error) {
        console.warn(
          "Optional dependency 'youtube-transcript' is not installed. Run `npm install youtube-transcript` to enable this feature."
        );
        return null;
      }
      if (videoId) {
        try {
          const youtubeTranscriptLanguage = options.youtubeTranscriptLanguage || "en";
          const transcript = await ytTranscript.fetchTranscript(videoId, {
            lang: youtubeTranscriptLanguage
          });
          transcriptText = transcript.map((part) => part.text).join(" ");
        } catch (error) {
          console.warn("Error while extracting the Youtube Transcript", error);
        }
      }
      if (transcriptText) {
        webpageText += `
### Transcript
${transcriptText}
`;
      }
    }
    const finalTitle = title ? title : doc.title;
    return { title: finalTitle, markdown: webpageText, text_content: webpageText };
  }
  _get(metadata, keys, default_value) {
    for (const k of keys) {
      if (metadata[k]) {
        return metadata[k];
      }
    }
    return default_value || null;
  }
  _findKey(json, key) {
    if (Array.isArray(json)) {
      for (const elm of json) {
        const ret = this._findKey(elm, key);
        if (ret) {
          return ret;
        }
      }
    } else if (typeof json === "object" && json !== null) {
      for (const k in json) {
        if (k === key) {
          return json[k];
        } else {
          const ret = this._findKey(json[k], key);
          if (ret) {
            return ret;
          }
        }
      }
    }
    return null;
  }
}

class IpynbConverter {
  async convert(source, options = {}) {
    const fileExtension = options.file_extension || "";
    if (fileExtension.toLowerCase() !== ".ipynb") {
      return null;
    }
    try {
      const contentStirng = typeof source === "string" ? fs__namespace.readFileSync(source, { encoding: "utf-8" }) : source.toString("utf-8");
      const notebookContent = JSON.parse(contentStirng);
      return this._convert(notebookContent);
    } catch (error) {
      console.error("Error converting .ipynb file:", error);
      return null;
    }
  }
  _convert(notebookContent) {
    try {
      const mdOutput = [];
      let title = null;
      for (const cell of notebookContent.cells || []) {
        const cellType = cell.cell_type || "";
        const sourceLines = cell.source || [];
        if (cellType === "markdown") {
          mdOutput.push(sourceLines.join(""));
          if (!title) {
            for (const line of sourceLines) {
              if (line.startsWith("# ")) {
                title = line.substring(line.indexOf("# ") + 2).trim();
                break;
              }
            }
          }
        } else if (cellType === "code") {
          mdOutput.push(`\`\`\`python
${sourceLines.join("")}
\`\`\``);
        } else if (cellType === "raw") {
          mdOutput.push(`\`\`\`
${sourceLines.join("")}
\`\`\``);
        }
      }
      const mdText = mdOutput.join("\n\n");
      title = notebookContent.metadata?.title || title;
      return { title, markdown: mdText, text_content: mdText };
    } catch (e) {
      console.error("Error converting .ipynb file:", e);
      throw new Error(`Error converting .ipynb file: ${e}`);
    }
  }
}

class BingSerpConverter {
  async convert(source, options = {}) {
    const fileExtension = options.file_extension || "";
    if (![".html", ".htm"].includes(fileExtension.toLowerCase())) {
      return null;
    }
    const url = options.url || "";
    if (!/^https:\/\/www\.bing\.com\/search\?q=/.test(url)) {
      return null;
    }
    try {
      const htmlContent = typeof source === "string" ? fs__namespace.readFileSync(source, { encoding: "utf-8" }) : Buffer.from(source).toString("utf-8");
      return this._convert(htmlContent, url);
    } catch (error) {
      console.error("Bing SERP Parsing Error:", error);
      return null;
    }
  }
  _convert(htmlContent, url$1) {
    const dom = new jsdom.JSDOM(htmlContent);
    const doc = dom.window.document;
    const parsedParams = new url.URL(url$1).searchParams;
    const query = parsedParams.get("q") || "";
    doc.querySelectorAll(".tptt").forEach((tptt) => {
      if (tptt.textContent) {
        tptt.textContent += " ";
      }
    });
    doc.querySelectorAll(".algoSlug_icon").forEach((slug) => {
      slug.remove();
    });
    const markdownify = new CustomTurnDown();
    const results = [];
    doc.querySelectorAll(".b_algo").forEach((result) => {
      result.querySelectorAll("a[href]").forEach((a) => {
        try {
          const parsedHref = new url.URL(a.getAttribute("href"));
          const params = parsedHref.searchParams;
          const u = params.get("u");
          if (u) {
            const decoded = this._decodeBase64Url(u);
            a.setAttribute("href", decoded);
          }
        } catch (e) {
        }
      });
      const mdResult = markdownify.convert_soup(result).trim();
      const lines = mdResult.split(/\n+/).map((line) => line.trim()).filter((line) => line.length > 0);
      results.push(lines.join("\n"));
    });
    const webpageText = `## A Bing search for '${query}' found the following results:

${results.join("\n\n")}`;
    return { title: doc.title, markdown: webpageText, text_content: webpageText };
  }
  _decodeBase64Url(encodedUrl) {
    let u = encodedUrl.slice(2).trim() + "==";
    try {
      const decoded = Buffer.from(u, "base64").toString("utf-8");
      return decoded;
    } catch (error) {
      console.error("Error decoding Base64URL:", error);
      return encodedUrl;
    }
  }
}

class PdfConverter {
  async convert(source, options = {}) {
    const fileExtension = options.file_extension || "";
    if (![".pdf"].includes(fileExtension.toLowerCase())) {
      return null;
    }
    try {
      const pdfContent = typeof source === "string" ? fs__default.readFileSync(source) : Buffer.from(source);
      return this._convert(pdfContent);
    } catch (error) {
      console.error("PDF Parsing Error:", error);
      return null;
    }
  }
  async _convert(pdfContent) {
    try {
      const parser = new pdfParse.PDFParse({ data: pdfContent });
      const result = await parser.getText();
      await parser.destroy();
      return { title: null, markdown: result.text, text_content: result.text };
    } catch (error) {
      console.error("PDF Parsing Error:", error);
      return null;
    }
  }
}

class DocxConverter extends HtmlConverter {
  async convert(source, options) {
    const fileExtension = options.file_extension || "";
    if (![".docx"].includes(fileExtension.toLowerCase())) {
      return null;
    }
    try {
      let mammothInput;
      if (typeof source === "string") {
        if (!fs__namespace.existsSync(source)) {
          throw new Error("File does'nt exists");
        }
        mammothInput = { path: source };
      } else {
        mammothInput = { buffer: Buffer.from(source) };
      }
      let htmlContent = await Mammoth__default.convertToHtml(mammothInput, {
        ...options
      });
      return await this._convert(htmlContent.value);
    } catch (e) {
      console.error(e);
      return null;
    }
  }
}

class XlsxConverter extends HtmlConverter {
  async convert(source, options) {
    const extension = options.file_extension || "";
    if (![".xlsx"].includes(extension.toLowerCase())) {
      return null;
    }
    try {
      let workbook;
      if (typeof source === "string") {
        if (!fs__namespace.existsSync(source)) {
          throw new Error("File does'nt exists");
        }
        workbook = XLSX__namespace.readFile(source);
      } else {
        workbook = XLSX__namespace.read(source, { type: "buffer" });
      }
      let mdContent = "";
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        if (sheet["!ref"]) {
          mdContent += `## ${sheetName}
`;
          let htmlContent = XLSX__namespace.utils.sheet_to_html(sheet);
          mdContent += (await this._convert(htmlContent))?.markdown.trim() + "\n\n";
        }
      }
      return { title: workbook?.Props?.Title || "Untitled", markdown: mdContent, text_content: mdContent };
    } catch (e) {
      console.error(e);
      return null;
    }
  }
}

const exec = util__namespace.promisify(childProcess__namespace.exec);
class MediaConverter {
  async _getMetadata(local_path) {
    const exiftool = await this._which("exiftool");
    if (!exiftool) {
      console.error("exiftool is not found on this system so metadata cannot be extracted");
      return null;
    }
    try {
      const result = await exec(`"${exiftool}" -json "${local_path}"`);
      return JSON.parse(result.stdout)[0];
    } catch (error) {
      console.error("Exiftool error:", error);
      return null;
    }
  }
  async _which(command) {
    try {
      const result = await exec(`which ${command}`);
      return result.stdout.trim();
    } catch (error) {
      console.warn("Which command error:", error);
      return null;
    }
  }
}

class WavConverter extends MediaConverter {
  async convert(source, options = {}) {
    const fileExtension = options.file_extension || "";
    if (fileExtension.toLowerCase() !== ".wav") {
      return null;
    }
    try {
      return this._convert(source, options);
    } catch (error) {
      console.error("WAV Conversion Error:", error);
      return null;
    }
  }
  async _convert(source, _) {
    let mdContent = "";
    if (typeof source === "string") {
      const metadata = await this._getMetadata(source);
      if (metadata) {
        for (const f of [
          "Title",
          "Artist",
          "Author",
          "Band",
          "Album",
          "Genre",
          "Track",
          "DateTimeOriginal",
          "CreateDate",
          "Duration"
        ]) {
          if (metadata[f]) {
            mdContent += `${f}: ${metadata[f]}
`;
          }
        }
      }
    } else {
      console.warn(
        "Metadata extraction is skipped for Buffer inputs as it requires a file path for exiftool."
      );
    }
    if (typeof source === "string") {
      try {
        const transcript = await this._transcribeAudio(source);
        mdContent += `

### Audio Transcript:
${transcript === "" ? "[No speech detected]" : transcript}`;
      } catch (error) {
        console.error("Error loading speech recognition module:", error);
        mdContent += "\n\n### Audio Transcript:\nError. Could not transcribe this audio.";
      }
    } else {
      mdContent += "\n\n### Audio Transcript:\n[Audio transcription is not supported for Buffer inputs in this version.]";
    }
    return { title: null, markdown: mdContent.trim(), text_content: mdContent.trim() };
  }
  // TODO: Add speech to text
  async _transcribeAudio(_) {
    throw new Error("TODO: Audio transcription not implemented yet");
  }
}

class Mp3Converter extends WavConverter {
  async convert(source, options = {}) {
    const fileExtension = options.file_extension || "";
    if (fileExtension.toLowerCase() !== ".mp3") {
      return null;
    }
    try {
      return await this._convert$(source, options);
    } catch (error) {
      console.error("MP3 Conversion Error:", error);
      return null;
    }
  }
  async _convert$(source, options) {
    let mdContent = "";
    if (typeof source === "string") {
      const metadata = await this._getMetadata(source);
      if (metadata) {
        for (const f of [
          "Title",
          "Artist",
          "Author",
          "Band",
          "Album",
          "Genre",
          "Track",
          "DateTimeOriginal",
          "CreateDate",
          "Duration"
        ]) {
          if (metadata[f]) {
            mdContent += `${f}: ${metadata[f]}
`;
          }
        }
      }
    } else {
      console.warn(
        "Metadata extraction is skipped for Buffer inputs as it requires a file path for exiftool."
      );
    }
    if (typeof source === "string") {
      const tempPath = await fs__namespace$1.mkdtemp(path__namespace.join(os__namespace.tmpdir(), "temp_"));
      const wavPath = path__namespace.join(tempPath, "audio.wav");
      try {
        const transcript = await super._transcribeAudio(wavPath);
        mdContent += `

### Audio Transcript:
${transcript == "" ? "[No speech detected]" : transcript}`;
      } catch (e) {
        mdContent += "\n\n### Audio Transcript:\nError. Could not transcribe this audio.";
      } finally {
        await fs__namespace$1.unlink(wavPath);
        await fs__namespace$1.rmdir(tempPath);
      }
    } else {
      mdContent += "\n\n### Audio Transcript:\n[Audio conversion and transcription are not supported for Buffer inputs.]";
    }
    return { title: null, markdown: mdContent.trim(), text_content: mdContent.trim() };
  }
}

class ImageConverter extends MediaConverter {
  async convert(source, options = {}) {
    const fileExtension = options.file_extension || "";
    if (![".jpg", ".jpeg", ".png"].includes(fileExtension.toLowerCase())) {
      return null;
    }
    try {
      return this._convert(source, options);
    } catch (error) {
      console.error("Image Conversion Error:", error);
      return null;
    }
  }
  async _convert(source, options) {
    let mdContent = "";
    if (typeof source === "string") {
      const metadata = await this._getMetadata(source);
      if (metadata) {
        for (const f of [
          "ImageSize",
          "Title",
          "Caption",
          "Description",
          "Keywords",
          "Artist",
          "Author",
          "DateTimeOriginal",
          "CreateDate",
          "GPSPosition"
        ]) {
          if (metadata[f]) {
            mdContent += `${f}: ${metadata[f]}
`;
          }
        }
      }
    } else {
      console.warn(
        "Metadata extraction is skipped for Buffer inputs as it requires a file path for exiftool."
      );
    }
    if (options.llmModel) {
      const imageBuffer = typeof source === "string" ? fs__namespace.readFileSync(source) : Buffer.from(source);
      mdContent += `
# Description:
${(await this._getLLMDescription(imageBuffer, options)).trim()}
`;
    }
    return { title: null, markdown: mdContent.trim(), text_content: mdContent.trim() };
  }
  async _getLLMDescription(imageBuffer, options) {
    if (!options.llmPrompt || options.llmPrompt.trim() === "") {
      options.llmPrompt = "Write a detailed caption for this image.";
    }
    const imageFileAsBase64 = imageBuffer.toString("base64");
    const result = await ai.generateText({
      model: options.llmModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: options.llmPrompt },
            {
              type: "image",
              image: imageFileAsBase64
            }
          ]
        }
      ]
    });
    return result.text.trim();
  }
}

class ZipConverter {
  async convert(source, options = {}) {
    const fileExtension = options.file_extension || "";
    if (fileExtension.toLowerCase() !== ".zip") {
      return null;
    }
    const parentConverters = options._parent_converters || [];
    if (!parentConverters) {
      return {
        title: null,
        markdown: `[ERROR] No converters available to process zip contents from: ${source}`,
        text_content: `[ERROR] No converters available to process zip contents from: ${source}`
      };
    }
    let unzipper2;
    try {
      unzipper2 = await import('unzipper').then((mod) => mod.default);
    } catch (error) {
      console.error(
        "Optional dependency 'unzipper' is not installed. Run `npm install unzipper` to enable this feature."
      );
      return null;
    }
    try {
      const zipFileName = typeof source === "string" ? path__namespace.basename(source) : "archive.zip";
      let mdContent = `Content from the zip file \`${zipFileName}\`:

`;
      const mdResults = [];
      const processEntry = async (entry) => {
        const relativePath = entry.path;
        if (entry.type === "File") {
          const entryExtension = path__namespace.extname(relativePath);
          const entryBuffer = await entry.buffer();
          const fileOptions = {
            ...options,
            file_extension: entryExtension,
            _parent_converters: parentConverters
          };
          for (const converter of parentConverters) {
            if (converter instanceof ZipConverter) {
              continue;
            }
            const result = await converter.convert(entryBuffer, fileOptions);
            if (result) {
              mdResults.push(`
## File: ${relativePath}

${result.markdown}

`);
              break;
            }
          }
        } else {
          entry.autodrain();
        }
      };
      const inputStream = typeof source === "string" ? fs__namespace.createReadStream(source) : new stream.PassThrough().end(source);
      await new Promise((res, rej) => {
        const parser = unzipper2.Parse();
        parser.on("entry", (entry) => {
          processEntry(entry).catch((err) => {
            parser.destroy(err);
            rej(err);
          });
        });
        parser.on("finish", res);
        parser.on("error", rej);
        inputStream.pipe(parser);
      });
      mdContent += mdResults.join("");
      return { title: null, markdown: mdContent.trim(), text_content: mdContent.trim() };
    } catch (error) {
      if (error.message.includes("invalid signature")) {
        return {
          title: null,
          markdown: `[ERROR] Invalid or corrupted zip file: ${source}`,
          text_content: `[ERROR] Invalid or corrupted zip file: ${source}`
        };
      }
      return {
        title: null,
        markdown: `[ERROR] Failed to process zip file ${source}: ${String(error)}`,
        text_content: `[ERROR] Failed to process zip file ${source}: ${String(error)}`
      };
    }
  }
}

class MarkItDown {
  converters = [];
  constructor() {
    this.register_converter(new PlainTextConverter());
    this.register_converter(new HtmlConverter());
    this.register_converter(new RSSConverter());
    this.register_converter(new WikipediaConverter());
    this.register_converter(new YouTubeConverter());
    this.register_converter(new BingSerpConverter());
    this.register_converter(new DocxConverter());
    this.register_converter(new XlsxConverter());
    this.register_converter(new WavConverter());
    this.register_converter(new Mp3Converter());
    this.register_converter(new ImageConverter());
    this.register_converter(new IpynbConverter());
    this.register_converter(new PdfConverter());
    this.register_converter(new ZipConverter());
  }
  /**
   * Converts a source from a file path, URL, or Response object.
   */
  async convert(source, options = {}) {
    if (source instanceof Response) {
      return await this.convert_response(source, options);
    } else {
      if (source.startsWith("http://") || source.startsWith("https://") || source.startsWith("file://")) {
        return await this.convert_url(source, options);
      } else {
        return this.convert_local(source, options);
      }
    }
  }
  /**
   * Converts a source from an in-memory Buffer.
   */
  async convertBuffer(source, options) {
    const extensions = /* @__PURE__ */ new Set([options.file_extension]);
    return this._convert(source, extensions, options);
  }
  async convert_url(source, { fetch = globalThis.fetch, ...options }) {
    let response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${source}, status: ${response.status}`);
    }
    return await this.convert_response(response, options);
  }
  async convert_response(response, options) {
    const ext = options.file_extension;
    const extensions = ext ? /* @__PURE__ */ new Set([ext]) : /* @__PURE__ */ new Set();
    const contentType = response.headers?.get("content-type")?.split(";")[0];
    if (!contentType) {
      throw new Error("Response Content-Type header is missing");
    }
    const mimeExtension = mime__namespace.extension(contentType);
    if (mimeExtension) {
      extensions.add(`.${mimeExtension}`);
    }
    const content_disposition = response.headers?.get("content-disposition") || "";
    const fname = content_disposition.match(/filename="([^;]+)"/);
    if (fname) {
      extensions.add(path__default.extname(fname[1]));
    }
    if (response.url) {
      const url_ext = path__default.extname(new URL(response.url).pathname);
      extensions.add(url_ext);
    }
    if (extensions.size === 0) {
      throw new Error(
        "Could not determine file type. Please provide a `file_extension` in the options."
      );
    }
    if (response.body == null) {
      throw new Error("Response body is empty");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return await this._convert(buffer, extensions, {
      ...options,
      url: response.url
    });
  }
  async convert_local(source, options) {
    const ext = options.file_extension;
    const extensions = ext ? new Set(ext) : /* @__PURE__ */ new Set();
    if (!fs__namespace.existsSync(source)) {
      throw new Error(`File not found: ${source}`);
    }
    const extname = path__default.extname(source);
    if (extname === "") {
      throw new Error(`File extension not found: ${source}`);
    }
    if (!extensions.has(extname)) {
      extensions.add(extname);
    }
    return await this._convert(source, extensions, options);
  }
  async _convert(source, extensions, options = {}) {
    let error;
    for (const ext of extensions) {
      for (const converter of this.converters) {
        let res;
        try {
          const op = {
            ...options,
            file_extension: ext,
            _parent_converters: this.converters
          };
          res = await converter.convert(source, op);
        } catch (e) {
          error = e;
        }
        if (res != null) {
          res.markdown = res.markdown.replace(/(?:\r\n|\r|\n)/g, "\n").trim();
          res.markdown = res.markdown.replace(/\n{3,}/g, "\n\n");
          return res;
        }
      }
    }
    if (error) {
      throw new Error(
        `Could not convert ${source} to markdown. While converting the following error occurred: ${error}`
      );
    }
    throw new Error(
      `Could not convert ${source} to markdown format. The ${Array.from(extensions).join(
        ", "
      )} are not supported.`
    );
  }
  // NOTE: Inserts the converter at the beginning of the list
  register_converter(converter) {
    this.converters.unshift(converter);
  }
}

exports.MarkItDown = MarkItDown;
