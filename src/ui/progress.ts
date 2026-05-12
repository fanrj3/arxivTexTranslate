type StepState = {
  label: string;
  detail: string;
  percent: number;
  state: "idle" | "active" | "done" | "error";
};

const STEP_LABELS: Record<string, string> = {
  service: "连接外部服务",
  import: "导入 arXiv 源码",
  translate: "服务端翻译",
  compile: "服务端编译 PDF",
  attach: "添加到 Zotero",
};

export class StepProgress {
  private dialog: any;
  private data: Record<string, string>;
  private stepStates: Record<string, StepState>;
  private openTarget: string;

  constructor(openTarget: string) {
    this.data = {};
    this.stepStates = {};
    this.openTarget = openTarget;

    const steps = Object.keys(STEP_LABELS);
    for (const id of steps) {
      this.stepStates[id] = {
        label: STEP_LABELS[id],
        detail: "",
        percent: 0,
        state: "idle",
      };
      this.data[`${id}_icon`] = "○";
      this.data[`${id}_label`] = STEP_LABELS[id];
      this.data[`${id}_detail`] = "";
      this.data[`${id}_bar_w`] = "0%";
    }
    this.data.summary = "等待开始";

    try {
      const dialog = new ztoolkit.Dialog(steps.length + 1, 1);
      steps.forEach((id, index) => {
        dialog.addCell(index, 0, this.renderStep(id), false);
      });
      dialog.addCell(steps.length, 0, {
        tag: "div",
        namespace: "html",
        attributes: { "data-bind": "summary", "data-prop": "textContent" },
        styles: {
          padding: "10px 12px",
          color: "#1f2937",
          fontSize: "13px",
          fontWeight: "600",
        },
      }, false);

      dialog.setDialogData(this.data);
      dialog.addButton("关闭", "close");
      dialog.addButton("打开服务", "open_service", {
        noClose: true,
        callback: () => {
          try { (Zotero as any).launchURL?.(this.openTarget); } catch {}
        },
      });
      dialog.open("arXiv Translate", {
        centerscreen: true,
        resizable: true,
        fitContent: false,
        width: 620,
        height: 390,
      });
      this.dialog = dialog;
    } catch (e) {
      ztoolkit.log("Dialog error:", e);
      this.dialog = null;
    }
  }

  addStep(id: string): void {
    const step = this.stepStates[id];
    if (!step) return;
    step.state = "active";
    this._set(`${id}_icon`, "●");
    this._set(`${id}_bar_w`, `${Math.max(step.percent, 5)}%`);
  }

  updateStep(id: string, percent: number, detail?: string): void {
    const step = this.stepStates[id];
    if (!step) return;
    step.state = "active";
    step.percent = Math.max(5, Math.min(99, percent));
    if (detail) step.detail = detail;
    this._set(`${id}_icon`, "●");
    this._set(`${id}_bar_w`, `${step.percent}%`);
    if (detail) this._set(`${id}_detail`, detail);
  }

  completeStep(id: string, detail?: string): void {
    const step = this.stepStates[id];
    if (!step) return;
    step.state = "done";
    step.percent = 100;
    if (detail) step.detail = detail;
    this._set(`${id}_icon`, "✓");
    this._set(`${id}_bar_w`, "100%");
    if (detail) this._set(`${id}_detail`, detail);
  }

  errorStep(id: string, detail: string): void {
    const step = this.stepStates[id];
    if (!step) return;
    step.state = "error";
    step.percent = 100;
    step.detail = detail;
    this._set(`${id}_icon`, "!");
    this._set(`${id}_detail`, detail);
    this._set(`${id}_bar_w`, "100%");
  }

  done(detail = "中文 PDF 已添加到 Zotero。"): void {
    this._set("summary", detail);
  }

  fail(detail: string): void {
    this._set("summary", detail);
  }

  destroy(): void {}

  private renderStep(id: string): any {
    return {
      tag: "div",
      namespace: "html",
      styles: {
        padding: "8px 12px",
        borderBottom: "1px solid #e5e7eb",
      },
      children: [
        {
          tag: "div",
          namespace: "html",
          styles: {
            display: "flex",
            alignItems: "center",
            gap: "8px",
          },
          children: [
            {
              tag: "span",
              namespace: "html",
              attributes: { "data-bind": `${id}_icon`, "data-prop": "textContent" },
              styles: {
                width: "18px",
                color: "#0f766e",
                fontWeight: "700",
              },
            },
            {
              tag: "span",
              namespace: "html",
              attributes: { "data-bind": `${id}_label`, "data-prop": "textContent" },
              styles: {
                flex: "1",
                fontSize: "13px",
                fontWeight: "600",
                color: "#111827",
              },
            },
            {
              tag: "span",
              namespace: "html",
              attributes: { "data-bind": `${id}_detail`, "data-prop": "textContent" },
              styles: {
                maxWidth: "310px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: "11px",
                color: "#64748b",
              },
            },
          ],
        },
        {
          tag: "div",
          namespace: "html",
          styles: {
            height: "4px",
            background: "#e5e7eb",
            marginTop: "6px",
            borderRadius: "999px",
            overflow: "hidden",
          },
          children: [
            {
              tag: "div",
              namespace: "html",
              attributes: { "data-bind": `${id}_bar_w`, "data-prop": "style.width" },
              styles: {
                height: "100%",
                width: "0%",
                background: "linear-gradient(90deg, #0f766e, #14b8a6)",
                borderRadius: "999px",
                transition: "width 0.25s ease",
              },
            },
          ],
        },
      ],
    };
  }

  private _set(key: string, value: string): void {
    this.data[key] = value;
    try {
      const el = this.dialog?.window?.document?.querySelector?.(`[data-bind="${key}"]`);
      if (!el) return;
      if (key.endsWith("_bar_w")) el.style.width = value;
      else el.textContent = value;
    } catch {}
  }
}
