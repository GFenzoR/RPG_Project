// The desktop game screen's windows (docs/17 UI-5): the toolbar opens them. The battle
// list and the inventory start open in the dock; skills, party, guild, appearance, options
// and help wait closed (ui/windows.ts defaultWindows).
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

export type WindowId =
  "battle" | "inventory" | "skills" | "party" | "guild" | "appearance" | "options" | "help";

/** Opens a window from the toolbar unless it is already open, and waits for it. */
export async function openWindow(page: Page, id: WindowId): Promise<void> {
  const button = page.getByTestId("toolbar").locator(`[data-window-button="${id}"]`);
  if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`.gwin[data-window="${id}"]`)).toBeVisible();
}

/** Closes a window with its ×, unless it is already closed. */
export async function closeWindow(page: Page, id: WindowId): Promise<void> {
  const win = page.locator(`.gwin[data-window="${id}"]`);
  if ((await win.count()) > 0) await page.getByTestId(`window-close-${id}`).click();
  await expect(win).toHaveCount(0);
}
