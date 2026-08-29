// Builds the message sent to Claude from the user's prompt plus the
// selected element(s). Loaded by the side panel via <script>, and by the
// bridge test suite via require() — keep it dependency-free and UMD-style.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PromptBuilder = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function describeElement(info, index, total) {
    const lines = [];
    const header = total > 1 ? `SELECTED ELEMENT ${index + 1} of ${total}:` : 'SELECTED ELEMENT:';
    lines.push(header);
    lines.push(`Tag: <${info.tag}>`);
    lines.push(`CSS selector: ${info.selector}`);
    if (info.id) lines.push(`ID: #${info.id}`);
    if (info.classes && info.classes.length) lines.push(`Classes: ${info.classes.join(', ')}`);
    if (info.source && info.source.fileName) {
      const line = info.source.lineNumber ? `:${info.source.lineNumber}` : '';
      lines.push(`Source file (from ${info.source.framework} dev build): ${info.source.fileName}${line}`);
      if (info.source.componentName) lines.push(`Component: ${info.source.componentName}`);
    }
    if (info.dimensions) lines.push(`Dimensions: ${info.dimensions.width}×${info.dimensions.height}px`);
    if (info.styles) {
      lines.push(`Computed styles: font-size=${info.styles.fontSize}, color=${info.styles.color}, bg=${info.styles.backgroundColor}`);
    }
    if (info.html) {
      lines.push('');
      lines.push('HTML:');
      lines.push(info.html.slice(0, 800));
    }
    return lines.join('\n');
  }

  // prompt: user text; elements: array of element info objects (may be empty);
  // opts.mode: 'edit' | 'explain'; opts.hasScreenshots: images are attached.
  function buildMessage(prompt, elements, opts) {
    opts = opts || {};
    const els = elements || [];
    let msg = prompt;

    if (els.length) {
      msg += '\n\n---\n';
      msg += els.map((el, i) => describeElement(el, i, els.length)).join('\n\n');
      const pageUrl = els[0].pageUrl;
      if (pageUrl) msg += `\n\nPage: ${pageUrl}`;
      msg += '\n---';
    }

    if (opts.hasScreenshots) {
      msg += '\n\nA screenshot of the selected element is attached.';
    }

    if (opts.mode === 'explain') {
      msg += '\n\nThis is a read-only request: explain, do not modify any file.';
    }

    return msg;
  }

  return { buildMessage, describeElement };
});
