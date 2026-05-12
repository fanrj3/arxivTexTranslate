/**
 * Electron main process: starts the local service and owns native window behavior.
 */

import { app, BrowserWindow, ipcMain, nativeImage, screen, shell } from "electron";
import { fork } from "child_process";
import { mkdirSync } from "fs";
import { randomUUID } from "crypto";
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

function startServer() {
  return new Promise((resolve) => {
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
      const message = data.toString();
      if (message.includes("running") || message.includes("Translation Service")) resolve();
      console.log("[server]", message.trim());
    });
    serverProcess.stderr.on("data", (data) => console.error("[server]", data.toString().trim()));
    setTimeout(resolve, 2000);
  });
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

function createWindow() {
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

  mainWindow.loadURL(LOCAL_ORIGIN);
  mainWindow.setMenuBarVisibility(false);
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
  await startServer();
  createWindow();
});

app.on("window-all-closed", () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});

ipcMain.on("feedback-start-drag", (event, filePath) => {
  if (!filePath || typeof filePath !== "string") return;
  event.sender.startDrag({ file: filePath, icon: DRAG_ICON });
});
