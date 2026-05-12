/**
 * Electron main process — starts server, creates window.
 */

import { app, BrowserWindow, Menu, shell, dialog, ipcMain } from "electron";
import { fork } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow = null;
let serverProcess = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const dataDir = app.getPath("userData");
    mkdirSync(dataDir, { recursive: true });
    serverProcess = fork(path.join(__dirname, "src", "server.js"), [], {
      env: { ...process.env, PORT: "3456", ARXIV_SERVICE_DATA_DIR: dataDir },
      silent: true,
    });
    serverProcess.stdout.on("data", (d) => {
      const msg = d.toString();
      if (msg.includes("running")) resolve();
      console.log("[server]", msg.trim());
    });
    serverProcess.stderr.on("data", (d) => console.error("[server]", d.toString().trim()));
    setTimeout(() => resolve(), 2000); // fallback
  });
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
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  mainWindow.loadURL("http://localhost:3456");
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(async () => {
  await startServer();
  createWindow();
});

app.on("window-all-closed", () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});
