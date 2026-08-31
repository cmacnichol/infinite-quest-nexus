import { parseHTML } from "linkedom";
import { afterEach, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  loader: (() => Promise.resolve()) as () => Promise<void>,
  mount: vi.fn(() => ({ dispose: vi.fn() }))
}));

vi.mock("../../apps/web-next/src/ui/feature-policy", () => ({ uiImplementation: () => "web-awesome" }));
vi.mock("../../apps/web-next/src/ui/web-awesome", () => ({ ensureWebAwesome: () => mocked.loader() }));
vi.mock("../../apps/web-next/src/world-library-page", () => ({ mountWorldLibraryPage: (...args: unknown[]) => mocked.mount(...args) }));

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function boot(loader: () => Promise<void>) {
  const { document } = parseHTML('<html><body><div id="app"></div></body></html>');
  const window = new EventTarget() as EventTarget & Pick<Window, "location" | "document">;
  Object.assign(window, { location: { pathname: "/app/", search: "" }, document });
  mocked.loader = loader;
  mocked.mount.mockClear();
  const previous = new Map<PropertyKey, PropertyDescriptor | undefined>();
  for (const [name, value] of [["window", window], ["document", window.document]] as const) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  vi.resetModules();
  await import("../../apps/web-next/src/bootstrap.js");
  return { window, mount: mocked.mount, restore: () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  } };
}

afterEach(() => { vi.resetModules(); });

it("does not mount after non-persisted pagehide while Core loading is pending", async () => {
  let resolve: (() => void) | undefined;
  const fixture = await boot(() => new Promise<void>((done) => { resolve = done; }));
  const hide = new Event("pagehide");
  Object.defineProperty(hide, "persisted", { value: false });
  fixture.window.dispatchEvent(hide);
  resolve?.();
  await settle();
  expect(fixture.mount).not.toHaveBeenCalled();
  fixture.restore();
});

it("retries a failed Core load without adding another pagehide listener", async () => {
  const loader = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce();
  const fixture = await boot(loader);
  await settle();
  fixture.window.document.querySelector<HTMLButtonElement>("button")?.click();
  await settle();
  expect(fixture.mount).toHaveBeenCalledOnce();
  const hide = new Event("pagehide");
  Object.defineProperty(hide, "persisted", { value: false });
  fixture.window.dispatchEvent(hide);
  fixture.restore();
});
