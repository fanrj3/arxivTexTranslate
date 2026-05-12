/**
 * Electron main process: starts the local service and owns native window behavior.
 */

import { app, BrowserWindow, ipcMain, nativeImage, screen, shell } from "electron";
import { fork } from "child_process";
import { mkdirSync } from "fs";
import { randomUUID } from "crypto";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PORT = "3456";
const LOCAL_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;
const PRELOAD = path.join(__dirname, "src", "electron", "preload.cjs");
const UI_ACCESS_TOKEN = randomUUID();

let mainWindow = null;
let serverProcess = null;

const DRAG_ICON = nativeImage.createFromDataURL(
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAARElEQVR4nO3UsQ0AIAgEQfz/6bY2FhGiwYkJzgrdM7sAABKJ9p4AAAD+ZgAASEgAAJCQAAAQEgAAJCQAAEhIAACQkAAAIH8GoQKfE4AqRQAAAABJRU5ErkJggg==",
);

function waitForServer(timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(`${LOCAL_ORIGIN}/api/settings`, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });
      request.setTimeout(1000, () => request.destroy(new Error("timeout")));
      request.on("error", retry);
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Service did not become ready at ${LOCAL_ORIGIN}`));
        return;
      }
      setTimeout(probe, 300);
    };
    probe();
  });
}

async function startServer() {
  if (serverProcess) return waitForServer();
  const dataDir = app.getPath("userData");
  mkdirSync(dataDir, { recursive: true });
  serverProcess = fork(path.join(__dirname, "src", "server.js"), [], {
    env: {
      ...process.env,
      PORT: SERVER_PORT,
      HOST: "127.0.0.1",
      ARXIV_SERVICE_DATA_DIR: dataDir,
      ARXIV_UI_ACCESS_TOKEN: UI_ACCESS_TOKEN,
    },
    silent: true,
  });
  serverProcess.stdout.on("data", (data) => {
    console.log("[server]", data.toString().trim());
  });
  serverProcess.stderr.on("data", (data) => console.error("[server]", data.toString().trim()));
  serverProcess.on("exit", (code, signal) => {
    serverProcess = null;
    console.error(`[server] exited: code=${code} signal=${signal}`);
  });
  await waitForServer();
}

function showStartupError(error) {
  const message = String(error?.message || error || "Unknown startup error");
  const html = `<!doctype html>
<html>
  <body style="font-family:Segoe UI,system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#f8fafc;color:#0f172a">
    <main style="max-width:640px;padding:32px">
      <h2>arXiv Translate failed to start</h2>
      <p style="line-height:1.6;color:#475569">${message}</p>
      <p style="line-height:1.6;color:#475569">Please close this window and run <code>npm run start</code> again. If port 3456 is occupied, stop the old process first.</p>
    </main>
  </body>
</html>`;
  if (!mainWindow) createWindow(false);
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function feedbackWindowOptions() {
  const display = screen.getPrimaryDisplay().workArea;
  return {
    width: 360,
    height: 220,
    x: display.x + display.width - 380,
    y: display.y + 90,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    title: "Feedback package",
    backgroundColor: "#f8fafc",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: PRELOAD,
    },
  };
}

function createWindow(loadApp = true) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    frame: true,
    titleBarStyle: "default",
    title: "arXiv Translate",
    backgroundColor: "#f8f9fa",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: PRELOAD,
    },
  });

  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: [`${LOCAL_ORIGIN}/*`] },
    (details, callback) => {
      details.requestHeaders["x-arxiv-ui-token"] = UI_ACCESS_TOKEN;
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  if (loadApp) mainWindow.loadURL(LOCAL_ORIGIN);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.on("did-fail-load", (_event, _errorCode, _errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || !validatedURL.startsWith(LOCAL_ORIGIN)) return;
    setTimeout(() => {
      waitForServer(5000)
        .then(() => mainWindow?.loadURL(LOCAL_ORIGIN))
        .catch(showStartupError);
    }, 500);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${LOCAL_ORIGIN}/feedback-floating.html`)) {
      return { action: "allow", overrideBrowserWindowOptions: feedbackWindowOptions() };
    }
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

app.whenReady().then(async () => {
  try {
    await startServer();
    createWindow();
  } catch (error) {
    showStartupError(error);
  }
});

app.on("window-all-closed", () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});

ipcMain.on("feedback-start-drag", (event, filePath) => {
  if (!filePath || typeof filePath !== "string") return;
  event.sender.startDrag({ file: filePath, icon: DRAG_ICON });
});

ipcMain.on("feedback-show-item", (_event, filePath) => {
  if (!filePath || typeof filePath !== "string") return;
  shell.showItemInFolder(filePath);
});
