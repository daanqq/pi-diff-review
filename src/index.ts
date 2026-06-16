import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { getReviewWindowData, loadReviewFileContents } from "./git.js";
import { composeReviewPrompt } from "./prompt.js";
import type {
  ReviewCancelPayload,
  ReviewFile,
  ReviewFileContents,
  ReviewHostMessage,
  ReviewRequestFilePayload,
  ReviewSubmitPayload,
  ReviewWindowMessage,
} from "./types.js";
import { buildReviewHtml } from "./ui.js";

function isSubmitPayload(value: ReviewWindowMessage): value is ReviewSubmitPayload {
  return value.type === "submit";
}

function isCancelPayload(value: ReviewWindowMessage): value is ReviewCancelPayload {
  return value.type === "cancel";
}

function isRequestFilePayload(value: ReviewWindowMessage): value is ReviewRequestFilePayload {
  return value.type === "request-file";
}

type WaitingEditorResult = "escape" | "window-settled";

export default function (pi: ExtensionAPI) {
  let activeServer: Server | null = null;
  let activePort: number | null = null;
  let activeSseClients: Set<ServerResponse> = new Set();
  let activeWaitingUIDismiss: (() => void) | null = null;

  function closeActiveServer(): void {
    if (activeServer == null) return;
    const server = activeServer;
    activeServer = null;
    activePort = null;
    // close all SSE connections first
    for (const res of activeSseClients) {
      try { res.end(); } catch {}
    }
    activeSseClients.clear();
    try {
      server.close();
    } catch {}
  }

  function showWaitingUI(ctx: ExtensionCommandContext, url: string): {
    promise: Promise<WaitingEditorResult>;
    dismiss: () => void;
  } {
    let settled = false;
    let doneFn: ((result: WaitingEditorResult) => void) | null = null;
    let pendingResult: WaitingEditorResult | null = null;

    const finish = (result: WaitingEditorResult): void => {
      if (settled) return;
      settled = true;
      if (activeWaitingUIDismiss === dismiss) {
        activeWaitingUIDismiss = null;
      }
      if (doneFn != null) {
        doneFn(result);
      } else {
        pendingResult = result;
      }
    };

    const promise = ctx.ui.custom<WaitingEditorResult>((_tui, theme, _kb, done) => {
      doneFn = done;
      if (pendingResult != null) {
        const result = pendingResult;
        pendingResult = null;
        queueMicrotask(() => done(result));
      }

      return {
        render(width: number): string[] {
          const innerWidth = Math.max(24, width - 2);
          const borderTop = theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
          const borderBottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
          const lines = [
            theme.fg("accent", theme.bold("Review window ready")),
            `Open in browser: ${url}`,
            "Press Escape to cancel and close the review server.",
          ];
          return [
            borderTop,
            ...lines.map((line) => `${theme.fg("border", "│")}${truncateToWidth(line, innerWidth, "...", true).padEnd(innerWidth, " ")}${theme.fg("border", "│")}`),
            borderBottom,
          ];
        },
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            finish("escape");
          }
        },
        invalidate(): void {},
      };
    });

    const dismiss = (): void => {
      finish("window-settled");
    };

    activeWaitingUIDismiss = dismiss;

    return {
      promise,
      dismiss,
    };
  }

  function sendSse(res: ServerResponse, data: string): void {
    res.write(`data: ${data}\n\n`);
  }

  async function reviewRepository(ctx: ExtensionCommandContext): Promise<void> {
    if (activeServer != null) {
      ctx.ui.notify("A review server is already running.", "warning");
      return;
    }

    const { repoRoot, files, commits } = await getReviewWindowData(pi, ctx.cwd);
    if (files.length === 0) {
      ctx.ui.notify("No reviewable files found.", "info");
      return;
    }

    const html = buildReviewHtml({ repoRoot, files, commits });
    const fileMap = new Map(files.map((file) => [file.id, file]));
    const contentCache = new Map<string, Promise<ReviewFileContents>>();

    const loadContents = (file: ReviewFile, scope: ReviewRequestFilePayload["scope"], commitSha?: string): Promise<ReviewFileContents> => {
      const cacheKey = `${scope}:${commitSha ?? ""}:${file.id}`;
      const cached = contentCache.get(cacheKey);
      if (cached != null) return cached;

      const pending = loadReviewFileContents(pi, repoRoot, file, scope, commitSha);
      contentCache.set(cacheKey, pending);
      return pending;
    };

    let reviewSettled = false;
    let reviewResolve: ((value: ReviewSubmitPayload | ReviewCancelPayload | null) => void) | null = null;

    const resolveReview = (value: ReviewSubmitPayload | ReviewCancelPayload | null): void => {
      if (reviewSettled) return;
      reviewSettled = true;
      reviewResolve?.(value);
    };

    let handleRequestFile: ((message: ReviewRequestFilePayload) => Promise<void>) | null = null;

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET" && (url === "/" || url === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && url === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        res.flushHeaders();

        activeSseClients.add(res);
        sendSse(res, JSON.stringify({ type: "connected" }));

        req.on("close", () => {
          activeSseClients.delete(res);
          // ponytail: cancel review when all browser tabs are closed
          if (activeSseClients.size === 0) {
            // small delay to let in-flight POST /api/message land first
            setTimeout(() => {
              if (activeSseClients.size === 0) resolveReview(null);
            }, 500);
          }
        });
        return;
      }

      if (req.method === "POST" && url === "/api/message") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        const body = Buffer.concat(chunks).toString("utf8");
        let message: ReviewWindowMessage;
        try {
          message = JSON.parse(body) as ReviewWindowMessage;
        } catch {
          res.writeHead(400);
          res.end("Invalid JSON");
          return;
        }

        res.writeHead(200);
        res.end("ok");

        if (isRequestFilePayload(message)) {
          void handleRequestFile?.(message);
        } else if (isSubmitPayload(message) || isCancelPayload(message)) {
          resolveReview(message);
        }
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    // Start server: try default port, fall back to next 10 ports if busy
    const DEFAULT_PORT = 9876;
    const MAX_ATTEMPTS = 10;
    let listenPort = DEFAULT_PORT;
    const startServer = (): Promise<void> => {
      return new Promise((resolve, reject) => {
        const tryListen = (attempt: number): void => {
          server.listen(listenPort, "127.0.0.1", () => {
            resolve();
          });
          server.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE" && attempt < MAX_ATTEMPTS) {
              listenPort++;
              tryListen(attempt + 1);
            } else {
              reject(err);
            }
          });
        };
        tryListen(0);
      });
    };
    await startServer();

    activeServer = server;
    activePort = listenPort;
    activeSseClients = new Set();

    const url = `http://localhost:${listenPort}`;

    // Try to open the browser automatically
    const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    pi.exec(openCmd, [url], { cwd: ctx.cwd }).catch(() => null);

    const waitingUI = showWaitingUI(ctx, url);

    const broadcastWindowMessage = (message: ReviewHostMessage): void => {
      const payload = JSON.stringify(message);
      for (const client of activeSseClients) {
        try { sendSse(client, payload); } catch {}
      }
    };

    handleRequestFile = async (message: ReviewRequestFilePayload): Promise<void> => {
      const file = fileMap.get(message.fileId);
      if (file == null) {
        broadcastWindowMessage({
          type: "file-error",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          commitSha: message.commitSha,
          message: "Unknown file requested.",
        });
        return;
      }

      try {
        const contents = await loadContents(file, message.scope, message.commitSha);
        broadcastWindowMessage({
          type: "file-data",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          commitSha: message.commitSha,
          originalContent: contents.originalContent,
          modifiedContent: contents.modifiedContent,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        broadcastWindowMessage({
          type: "file-error",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          commitSha: message.commitSha,
          message: messageText,
        });
      }
    };

    const terminalMessagePromise = new Promise<ReviewSubmitPayload | ReviewCancelPayload | null>((resolve) => {
      reviewResolve = resolve;
    });

    ctx.ui.notify(`Review server: ${url}`, "info");

    try {
      const result = await Promise.race([
        terminalMessagePromise.then((message) => ({ type: "window" as const, message })),
        waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
      ]);

      if (result.type === "ui" && result.reason === "escape") {
        resolveReview(null);
        closeActiveServer();
        await terminalMessagePromise.catch(() => null);
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const message = result.type === "window" ? result.message : await terminalMessagePromise;

      waitingUI.dismiss();
      await waitingUI.promise;
      closeActiveServer();

      if (message == null || message.type === "cancel") {
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const prompt = composeReviewPrompt(files, message);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted review feedback into the editor.", "info");
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveServer();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Review failed: ${message}`, "error");
    }
  }

  pi.registerCommand("diff-review", {
    description: "Open a browser review window with git diff, last commit, and all files scopes",
    handler: async (_args, ctx) => {
      await reviewRepository(ctx);
    },
  });

  pi.on("session_shutdown", async () => {
    activeWaitingUIDismiss?.();
    closeActiveServer();
  });
}
