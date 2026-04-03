import { test, expect, type Page } from "@playwright/test";

function captureErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

/** Navigate as a returning user (tutorial done, username set) to skip new-user gate flow. */
async function gotoAsReturningUser(page: Page, url = "/") {
  await page.addInitScript(() => {
    localStorage.setItem("chickenz-tutorial-done", "1");
    if (!localStorage.getItem("chickenz-username")) {
      localStorage.setItem("chickenz-username", "Tester");
    }
  });
  await page.goto(url);
}

async function waitForLobby(page: Page) {
  // lobby.open() sets data-ready="1" after WS connects — ensures buttons are ready
  await expect(page.locator("#lobby-overlay[data-ready]")).toBeVisible({ timeout: 15_000 });
}

async function waitForLobbyVisible(page: Page) {
  // Lighter check for tests that only need the lobby overlay to appear, not full WS readiness
  await expect(page.locator("#lobby-overlay")).toBeVisible({ timeout: 15_000 });
}

test.describe("Page load", () => {
  test("loads without uncaught JS errors", async ({ page }) => {
    const errors = captureErrors(page);
    await gotoAsReturningUser(page);
    await waitForLobby(page);
    expect(errors, `Uncaught errors: ${errors.join(", ")}`).toHaveLength(0);
  });

  test("lobby shows all action buttons", async ({ page }) => {
    await gotoAsReturningUser(page);
    await waitForLobby(page);
    await expect(page.locator("#btn-quickplay")).toBeVisible();
    await expect(page.locator("#btn-create-public")).toBeVisible();
    await expect(page.locator("#btn-create-private")).toBeVisible();
    await expect(page.locator("#btn-mode-casual")).toBeVisible();
    await expect(page.locator("#btn-mode-ranked")).toBeVisible();
  });

  test("top bar shows username", async ({ page }) => {
    await gotoAsReturningUser(page);
    await waitForLobby(page);
    const username = page.locator("#top-bar-username");
    await expect(username).toBeVisible();
    await expect(username).not.toHaveText("");
  });
});

test.describe("Settings panel", () => {
  test("opens via button and closes with Escape", async ({ page }) => {
    await gotoAsReturningUser(page);
    await waitForLobby(page);

    await page.click("#btn-settings");
    await expect(page.locator("#settings-overlay.visible")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("#settings-overlay.visible")).toBeHidden();
  });

  test("opens and closes via X button", async ({ page }) => {
    await gotoAsReturningUser(page);
    await waitForLobby(page);

    await page.click("#btn-settings");
    await expect(page.locator("#settings-overlay.visible")).toBeVisible();

    await page.click("#settings-close");
    await expect(page.locator("#settings-overlay.visible")).toBeHidden();
  });
});

test.describe("Region selector", () => {
  test("opens dropdown with at least one region", async ({ page }) => {
    await gotoAsReturningUser(page);
    await waitForLobby(page);

    await page.click("#btn-region");
    await expect(page.locator("#region-dropdown")).toBeVisible();
    await expect(page.locator(".region-option").first()).toBeVisible();
  });

  test("closes on outside click", async ({ page }) => {
    await gotoAsReturningUser(page);
    await waitForLobby(page);

    await page.click("#btn-region");
    await expect(page.locator("#region-dropdown")).toBeVisible();

    await page.click("body", { position: { x: 10, y: 10 } });
    await expect(page.locator("#region-dropdown")).toBeHidden();
  });
});

test.describe("Room creation", () => {
  test("quickplay enters waiting room", async ({ page }) => {
    await gotoAsReturningUser(page);
    await waitForLobby(page);

    await page.click("#btn-quickplay");
    await expect(page.locator("#lobby-overlay")).toBeHidden({ timeout: 10_000 });
  });

  test("create private room puts join code in URL", async ({ page }) => {
    await gotoAsReturningUser(page);
    await waitForLobby(page);

    await page.click("#btn-create-private");
    await expect(page.locator("#lobby-overlay")).toBeHidden({ timeout: 10_000 });
    await expect(page).toHaveURL(/\?join=[A-Z]{5}/);
  });

  test("create public room clears lobby", async ({ page }) => {
    await gotoAsReturningUser(page);
    await waitForLobby(page);

    await page.click("#btn-create-public");
    await expect(page.locator("#lobby-overlay")).toBeHidden({ timeout: 10_000 });
  });
});

test.describe("URL deep links", () => {
  test("?join= with bogus code shows lobby without crashing", async ({ page }) => {
    const errors = captureErrors(page);
    await gotoAsReturningUser(page, "/?join=ZZZZZ");
    await waitForLobbyVisible(page);
    await page.waitForTimeout(3_000); // wait for join attempt to resolve/fail
    expect(errors, `Uncaught errors: ${errors.join(", ")}`).toHaveLength(0);
    await expect(page.locator("#lobby-overlay")).toBeVisible();
  });

  test("?replay= with unknown ID shows lobby without crashing", async ({ page }) => {
    const errors = captureErrors(page);
    await gotoAsReturningUser(page, "/?replay=nonexistent-room-id&region=us");
    await waitForLobbyVisible(page);
    await page.waitForTimeout(3_000); // wait for replay fetch to fail and return to lobby
    expect(errors, `Uncaught errors: ${errors.join(", ")}`).toHaveLength(0);
    await expect(page.locator("#lobby-overlay")).toBeVisible();
  });
});

test.describe("Mode toggle", () => {
  test("switching modes does not crash", async ({ page }) => {
    await gotoAsReturningUser(page);
    await waitForLobby(page);

    const errors = captureErrors(page);
    await page.click("#btn-mode-ranked");
    await page.click("#btn-mode-casual");
    await page.waitForTimeout(300);
    expect(errors, `Uncaught errors: ${errors.join(", ")}`).toHaveLength(0);
  });
});
