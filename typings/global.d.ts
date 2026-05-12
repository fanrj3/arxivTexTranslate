declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const ztoolkit: ZToolkit;

declare const rootURI: string;

declare const addon: import("../src/addon").default;

declare const __env__: "production" | "development";

declare module "pako" { export = pako; }

declare namespace Zotero {
  function getActiveZoteroPane(): _ZoteroTypes.MainWindow | undefined;
  var DataDirectory: string;
  var platform: string;
  var Promise: typeof Promise & { delay(ms: number): Promise<void> };
  var Items: any;
  var Attachments: any;
  var ItemPaneManager: any;
  var PreferencePanes: any;
  var Notifier: any;
  var File: any;
  var HTTP: any;
  var Utilities: any;
  var Plugins: any;
}
