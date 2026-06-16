import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewWindowData } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, "..", "web");

function escapeForInlineScript(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

const sseBridgeScript = `
(function() {
  var es = new EventSource('/api/events');
  es.onmessage = function(e) {
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === 'connected') return;
      window.__reviewReceive(msg);
    } catch(_) {}
  };
  var _pendingSend = null;
  window.glimpse = {
    send: function(payload) {
      _pendingSend = fetch('/api/message', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
      }).catch(function(){});
      return _pendingSend;
    },
    close: function() {
      es.close();
      // wait for pending fetch before closing the tab
      (_pendingSend || Promise.resolve()).then(function() {
        try { window.close(); } catch(_) {}
      });
    }
  };
})();
`;

export function buildReviewHtml(data: ReviewWindowData): string {
  const templateHtml = readFileSync(join(webDir, "index.html"), "utf8");
  const appJs = readFileSync(join(webDir, "app.js"), "utf8");
  const payload = escapeForInlineScript(JSON.stringify(data));
  return templateHtml
    .replace("__INLINE_DATA__", payload)
    .replace("__INLINE_JS__", sseBridgeScript + "\n" + appJs);
}
