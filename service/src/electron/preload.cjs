const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("feedbackBridge", {
  startDrag(filePath) {
    if (typeof filePath === "string" && filePath) {
      ipcRenderer.send("feedback-start-drag", filePath);
    }
  },
});
