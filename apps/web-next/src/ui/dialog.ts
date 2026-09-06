import "./dialog.css";

export interface DialogHandle {
  readonly element: HTMLDialogElement;
  readonly body: HTMLElement;
  readonly footer: HTMLElement;
  open(opener?: HTMLElement | null): void;
  close(): void;
  dispose(): void;
}

export interface DialogOptions {
  readonly label: string;
  readonly onClose?: () => void;
}

let nextDialogTitleId = 0;

function activeElement(document: Document): HTMLElement | null {
  const candidate = document.activeElement;
  return candidate?.nodeType === 1 && typeof (candidate as HTMLElement).focus === "function"
    ? candidate as HTMLElement
    : null;
}

function isOpen(dialog: HTMLDialogElement): boolean {
  return dialog.open || dialog.hasAttribute("open");
}

export function mountDialog(document: Document, options: Readonly<DialogOptions>): DialogHandle {
  const element = document.createElement("dialog");
  element.className = "app-dialog";
  element.setAttribute("aria-modal", "true");

  const heading = document.createElement("h2");
  heading.className = "app-dialog__title";
  heading.id = `infinite-quest-dialog-title-${++nextDialogTitleId}`;
  heading.textContent = options.label;
  element.setAttribute("aria-labelledby", heading.id);

  const closeButton = document.createElement("button");
  closeButton.className = "app-dialog__close";
  closeButton.type = "button";
  closeButton.textContent = "Close";
  closeButton.setAttribute("aria-label", `Close ${options.label}`);

  const header = document.createElement("header");
  header.className = "app-dialog__header";
  header.append(heading, closeButton);

  const body = document.createElement("div");
  body.className = "app-dialog__body";
  const footer = document.createElement("footer");
  footer.className = "app-dialog__footer";
  element.append(header, body, footer);

  let disposed = false;
  let opener: HTMLElement | null = null;

  const restoreOpener = () => {
    const previousOpener = opener;
    opener = null;
    if (previousOpener?.isConnected) previousOpener.focus();
    options.onClose?.();
  };

  const close = () => {
    if (disposed || !isOpen(element)) return;
    element.close();
  };

  const open = (nextOpener: HTMLElement | null = activeElement(document)) => {
    if (disposed || isOpen(element)) return;
    opener = nextOpener;
    element.showModal();
    closeButton.focus();
  };

  const dispose = () => {
    if (disposed) return;
    close();
    disposed = true;
    closeButton.removeEventListener("click", close);
    element.removeEventListener("close", restoreOpener);
    element.remove();
  };

  closeButton.addEventListener("click", close);
  element.addEventListener("close", restoreOpener);

  return { element, body, footer, open, close, dispose };
}
