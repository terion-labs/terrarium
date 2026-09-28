import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { OidcTestUser } from "../types";

type LoginExpectation = "allow" | "deny";
type BrowserArtifactKind = "success" | "failure";
type PasswordWaitResult = { state: "password"; selector: string } | { state: "target" };

type LoginOptions = {
  outputDir: string;
  resolveHosts?: Record<string, string>;
  expected?: LoginExpectation;
  ignoreHTTPSErrors?: boolean;
  postLoginBodyMarkers?: readonly string[];
  postLoginLabel?: string;
};

const BROWSER_WAIT_TIMEOUT_MS = 120000;
const BROWSER_FLOW_TIMEOUT_MS = 180000;
const BROWSER_LIFECYCLE_TIMEOUT_MS = 15 * 60 * 1000;
const BROWSER_LOGIN_ATTEMPTS = 3;
const BROWSER_CLOSE_TIMEOUT_MS = 10000;
const BROWSER_CLICK_TIMEOUT_MS = 10000;
const BROWSER_POLL_TIMEOUT_MS = 1000;
const BROWSER_INPUT_ATTEMPT_TIMEOUT_MS = 10000;
const BROWSER_INPUT_TOTAL_TIMEOUT_MS = 45000;
const BROWSER_LOGIN_DOCUMENT_TIMEOUT_MS = 30000;
const BROWSER_OIDC_START_TIMEOUT_MS = 30000;
const BROWSER_OIDC_HANDOFF_TIMEOUT_MS = 5000;
const BROWSER_OIDC_RECLICK_INTERVAL_MS = 2000;
const BROWSER_METADATA_TIMEOUT_MS = 5000;
const BROWSER_SCREENSHOT_TIMEOUT_MS = 15000;
const BODY_SNIPPET_LENGTH = 4000;
const DENIAL_TEXT_MARKERS = ["403", "forbidden", "access denied", "not authorized", "permission denied"] as const;
const ERROR_TEXT_MARKERS = [
  "400 bad request",
  "401 unauthorized",
  "403 forbidden",
  "404 page not found",
  "500 internal server error",
  "502 bad gateway",
  "503 service unavailable",
  "504 gateway timeout",
  "bad gateway",
  "service unavailable",
  "gateway timeout"
] as const;
const COCKPIT_TEXT_MARKERS = ["Cockpit", "Log in", "Username", "Password", "Ubuntu 24.04", "Ubuntu 26.04"] as const;
const TRAEFIK_TEXT_MARKERS = ["Traefik", "Dashboard", "HTTP", "Routers", "Services"] as const;
const LXD_TEXT_MARKERS = ["LXD", "Instances", "Projects", "Storage"] as const;
const USERNAME_INPUT_SELECTORS = [
  '[data-testid="username-text-input"]',
  'input[name="loginName"]',
  'input[autocomplete="username"]',
  'input[type="email"]',
  'input[name="username"]',
  'input[placeholder*="email" i]',
  'input[placeholder*="login" i]',
  'input[placeholder*="username" i]',
  'input[type="text"]',
  "input:not([type])"
] as const;
const PASSWORD_INPUT_SELECTORS = [
  '[data-testid="password-text-input"]',
  'input[name="password"]',
  'input[autocomplete="password"]',
  'input[autocomplete="current-password"]',
  'input[type="password"]'
] as const;
const USERNAME_SUBMIT_SELECTORS = submitControlSelectors(["Next", "Continue", "Sign in"]);
const PASSWORD_SUBMIT_SELECTORS = submitControlSelectors(["Sign in", "Login", "Continue"]);

export function shouldIgnoreHttpsErrors(options: { resolveHosts?: Record<string, string>; ignoreHTTPSErrors?: boolean }): boolean {
  return options.ignoreHTTPSErrors ?? Object.keys(options.resolveHosts ?? {}).length > 0;
}

export function browserLifecycleTimeoutForLoginTargets(targetCount: number): number {
  return BROWSER_FLOW_TIMEOUT_MS * BROWSER_LOGIN_ATTEMPTS * targetCount + BROWSER_WAIT_TIMEOUT_MS;
}
const CONSENT_SUBMIT_SELECTORS = ["Allow", "Authorize", "Approve", "Accept", "Continue", "Grant access"].flatMap((label) => [
  `button:has-text("${label}")`,
  `[role="button"]:has-text("${label}")`,
  `input[type="submit"][value="${label}"]`,
  `input[type="button"][value="${label}"]`
]);

async function waitForPasswordInputAfterUsernameSubmit(page: Page, usernameSelector: string, userEmail: string, targetHost: string): Promise<PasswordWaitResult> {
  const deadline = Date.now() + BROWSER_WAIT_TIMEOUT_MS;
  let lastResubmit = 0;
  let lastBody = "";

  while (Date.now() < deadline) {
    const currentUrl = page.url();
    if (isTargetApplicationPage(currentUrl, targetHost)) {
      return { state: "target" };
    }

    if (isPasswordLoginStep(currentUrl) && await reloadBlankLoginDocumentIfNeeded(page)) {
      await page.waitForTimeout(1000);
      continue;
    }

    if (isPasswordLoginStep(currentUrl)) {
      const selector = await visiblePasswordInputSelector(page, 5000);
      if (selector) {
        return { state: "password", selector };
      }
    }

    if (isIdentityLoginInputPage(currentUrl, targetHost)) {
      for (const selector of PASSWORD_INPUT_SELECTORS) {
        const locator = page.locator(selector).first();
        if (await locatorVisible(locator)) {
          return { state: "password", selector };
        }
      }
    }

    lastBody = (await maybeWithTimeout(page.locator("body").innerText({ timeout: 1000 }).catch(() => ""), 2000)) ?? "";
    const normalizedBody = lastBody.toLowerCase();
    if (
      normalizedBody.includes("user not found") ||
      normalizedBody.includes("invalid login") ||
      normalizedBody.includes("login failed")
    ) {
      throw new Error(`ZITADEL username step failed before password input\nbody:\n${bodySnippetForError(lastBody)}`);
    }

    if (isUsernameLoginStep(currentUrl) && isIdentityLoginInputPage(currentUrl, targetHost)) {
      const now = Date.now();
      if (now - lastResubmit > 5000) {
        lastResubmit = now;
        await resubmitUsernameIfStillOnUsernameStep(page, userEmail);
        await page.waitForTimeout(1000);
        continue;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    [
      `none of the password selectors were visible after username submit: ${PASSWORD_INPUT_SELECTORS.join(", ")}`,
      `current URL: ${page.url()}`,
      `body:\n${bodySnippetForError(lastBody) || "<empty>"}`
    ].join("\n")
  );
}

async function visiblePasswordInputSelector(page: Page, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of PASSWORD_INPUT_SELECTORS) {
      const locator = page.locator(selector).first();
      if (await locatorVisible(locator)) {
        return selector;
      }
    }

    await page.waitForTimeout(250);
  }

  return undefined;
}

async function resubmitUsernameIfStillOnUsernameStep(page: Page, userEmail: string): Promise<void> {
  await maybeWithTimeout(
    page
      .evaluate(
        ({ inputSelectors, submitSelectors, value }) => {
          if (!location.pathname.toLowerCase().startsWith("/ui/v2/login/loginname")) {
            return;
          }

          const input = inputSelectors
            .map((selector) => document.querySelector(selector))
            .find((element): element is HTMLInputElement => element instanceof HTMLInputElement && !element.disabled && !element.readOnly);
          if (!input) {
            return;
          }

          input.focus();
          const valueSetter = Object.getOwnPropertyDescriptor(input, "value")?.set;
          const prototypeValueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
          (prototypeValueSetter ?? valueSetter)?.call(input, value);
          input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
          input.dispatchEvent(new Event("change", { bubbles: true }));

          const submitFromKnownSelector = submitSelectors
            .filter((selector) => !selector.startsWith("text="))
            .map((selector) => {
              try {
                return document.querySelector(selector);
              } catch {
                return undefined;
              }
            })
            .find((element): element is HTMLButtonElement | HTMLInputElement => {
              if (!(element instanceof HTMLButtonElement || element instanceof HTMLInputElement) || element.disabled) {
                return false;
              }
              const style = getComputedStyle(element);
              return style.visibility !== "hidden" && style.display !== "none";
            });
          const submit =
            submitFromKnownSelector ??
            Array.from(document.querySelectorAll("button,input"))
            .find((element): element is HTMLButtonElement | HTMLInputElement => {
              if (!(element instanceof HTMLButtonElement || element instanceof HTMLInputElement) || element.disabled) {
                return false;
              }
              const text = `${element.textContent ?? ""} ${element.value ?? ""}`.toLowerCase();
              return element.type === "submit" || text.includes("continue") || text.includes("next") || text.includes("sign in");
            });
          if (submit) {
            submit.click();
            return;
          }

          const form = input.closest("form");
          if (form && typeof form.requestSubmit === "function") {
            form.requestSubmit();
          }
        },
        { inputSelectors: USERNAME_INPUT_SELECTORS, submitSelectors: USERNAME_SUBMIT_SELECTORS, value: userEmail }
      )
      .catch(() => undefined),
    3000
  );
}

export const __browserTestHooks = {
  resubmitUsernameIfStillOnUsernameStep,
  submitIdentityForm,
  waitForPasswordInputAfterUsernameSubmit
};

function isUsernameLoginStep(currentUrl: string): boolean {
  const parsedUrl = parseBrowserUrl(currentUrl);
  return parsedUrl?.pathname.toLowerCase().startsWith("/ui/v2/login/loginname") ?? false;
}

function isPasswordLoginStep(currentUrl: string): boolean {
  const parsedUrl = parseBrowserUrl(currentUrl);
  return parsedUrl?.pathname.toLowerCase().startsWith("/ui/v2/login/password") ?? false;
}

async function reloadBlankLoginDocumentIfNeeded(page: Page): Promise<boolean> {
  const parsed = parseBrowserUrl(page.url());
  if (!parsed || !isLoginOrOauthCallbackPlumbingPath(parsed.pathname)) {
    return false;
  }

  const body = (await maybeWithTimeout(page.locator("body").innerText({ timeout: 1000 }).catch(() => ""), 2000)) ?? "";
  if (body.trim()) {
    return false;
  }

  await maybeWithTimeout(page.reload({ waitUntil: "commit", timeout: 10000 }).catch(() => undefined), 12000);
  return true;
}

async function clickFirst(page: Page, selectors: string[]): Promise<void> {
  const deadline = Date.now() + BROWSER_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await clickFirstVisible(page, selectors)) {
      return;
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`none of the click selectors became enabled: ${selectors.join(", ")}`);
}

async function clickFirstVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (
      (await locatorVisible(locator)) &&
      !(await locatorDisabled(locator))
    ) {
      const clicked = await maybeWithTimeout(
        locator.click({ noWaitAfter: true, timeout: BROWSER_CLICK_TIMEOUT_MS }).then(() => true).catch(() => false),
        BROWSER_CLICK_TIMEOUT_MS + 1000
      );
      if (clicked) {
        return true;
      }
    }
  }
  return false;
}

async function inputVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
  for (const selector of selectors) {
    if (await locatorVisible(page.locator(selector).first())) {
      return true;
    }
  }
  return false;
}

async function firstIdentityInput(page: Page, selectors: readonly string[], targetHost: string): Promise<string> {
  const deadline = Date.now() + BROWSER_WAIT_TIMEOUT_MS;
  let lastBody = "";

  while (Date.now() < deadline) {
    const currentUrl = page.url();
    if (isTargetLoginOrOauthPlumbingPage(currentUrl, targetHost)) {
      await clickOidcStartIfNeeded(page, targetHost);
    }

    if (isIdentityLoginInputPage(page.url(), targetHost)) {
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if (await locatorVisible(locator)) {
          return selector;
        }
      }
    }

    if (await reloadBlankLoginDocumentIfNeeded(page)) {
      await page.waitForTimeout(1000);
      continue;
    }

    lastBody = (await maybeWithTimeout(page.locator("body").innerText({ timeout: 1000 }).catch(() => ""), 2000)) ?? "";
    await page.waitForTimeout(500);
  }

  throw new Error(
    [
      `none of the identity selectors were visible: ${selectors.join(", ")}`,
      `current URL: ${page.url()}`,
      `body:\n${bodySnippetForError(lastBody) || "<empty>"}`
    ].join("\n")
  );
}

async function clickOidcStartIfNeeded(page: Page, targetHost: string): Promise<void> {
  const deadline = Date.now() + BROWSER_OIDC_START_TIMEOUT_MS;
  let reloadedBlankTargetLoginPage = false;
  let lastBody = "";
  let lastStartClick = 0;

  while (Date.now() < deadline) {
    if ((await inputVisible(page, USERNAME_INPUT_SELECTORS)) && isIdentityLoginInputPage(page.url(), targetHost)) {
      return;
    }
    const parsed = parseBrowserUrl(page.url());
    if (parsed && parsed.host !== targetHost) {
      return;
    }
    if (parsed && parsed.host === targetHost && !isLoginOrOauthCallbackPlumbingPath(parsed.pathname)) {
      return;
    }

    await maybeWithTimeout(page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined), 4000);
    lastBody = (await maybeWithTimeout(page.locator("body").innerText({ timeout: 1000 }).catch(() => ""), 2000)) ?? "";
    if (!lastBody.trim() && !reloadedBlankTargetLoginPage && parsed && isLoginOrOauthCallbackPlumbingPath(parsed.pathname)) {
      reloadedBlankTargetLoginPage = true;
      await maybeWithTimeout(page.reload({ waitUntil: "commit", timeout: 10000 }).catch(() => undefined), 12000);
      await page.waitForTimeout(1000);
      continue;
    }

    const lxdOidcLoginUrl = lxdOidcLoginUrlForSsoPage(page.url(), lastBody, targetHost);
    if (lxdOidcLoginUrl && Date.now() - lastStartClick > BROWSER_OIDC_RECLICK_INTERVAL_MS) {
      lastStartClick = Date.now();
      await maybeWithTimeout(page.goto(lxdOidcLoginUrl, { waitUntil: "commit", timeout: BROWSER_CLICK_TIMEOUT_MS }).catch(() => undefined), 12000);
      await waitForOidcStartHandoff(page, targetHost);
      continue;
    }

    const startSelectors = [
      'button:has-text("Login with SSO")',
      'a:has-text("Login with SSO")',
      'a:has-text("Log in")',
      'button:has-text("Log in")',
      'a:has-text("Login")',
      'button:has-text("Login")',
      'a:has-text("Sign in")',
      'button:has-text("Sign in")',
      'a:has-text("Single sign-on")',
      'button:has-text("Single sign-on")',
      'a:has-text("SSO")',
      'button:has-text("SSO")',
      'a:has-text("OIDC")',
      'button:has-text("OIDC")',
      'a:has-text("OpenID")',
      'button:has-text("OpenID")'
    ];
    for (const selector of startSelectors) {
      const locator = page.locator(selector).first();
      if (
        Date.now() - lastStartClick > BROWSER_OIDC_RECLICK_INTERVAL_MS &&
        (await locatorVisible(locator)) &&
        !(await locatorDisabled(locator))
      ) {
        lastStartClick = Date.now();
        await locator.click({ noWaitAfter: true, timeout: BROWSER_CLICK_TIMEOUT_MS });
        await waitForOidcStartHandoff(page, targetHost);
        break;
      }
    }

    await page.waitForTimeout(250);
  }

  if (parseBrowserUrl(page.url())?.host === targetHost) {
    throw new Error(
      [
        `target login page did not expose an OIDC start control: ${page.url()}`,
        `body:\n${bodySnippetForError(lastBody) || "<empty>"}`
      ].join("\n")
    );
  }
}

async function waitForOidcStartHandoff(page: Page, targetHost: string): Promise<void> {
  const deadline = Date.now() + BROWSER_OIDC_HANDOFF_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await inputVisible(page, USERNAME_INPUT_SELECTORS)) && isIdentityLoginInputPage(page.url(), targetHost)) {
      return;
    }

    const parsed = parseBrowserUrl(page.url());
    if (!parsed || parsed.host !== targetHost || !isLoginOrOauthCallbackPlumbingPath(parsed.pathname)) {
      return;
    }

    await page.waitForTimeout(250);
  }
}

async function waitForIdentityLoginDocument(page: Page, targetHost: string): Promise<void> {
  const deadline = Date.now() + BROWSER_LOGIN_DOCUMENT_TIMEOUT_MS;
  let reloadedBlankLoginPage = false;
  let lastBody = "";

  while (Date.now() < deadline) {
    const currentUrl = page.url();
    const parsed = parseBrowserUrl(currentUrl);
    if (parsed?.host === targetHost && !isLoginOrOauthCallbackPlumbingPath(parsed.pathname)) {
      return;
    }

    await maybeWithTimeout(page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined), 4000);
    if ((await inputVisible(page, USERNAME_INPUT_SELECTORS)) && isIdentityLoginInputPage(currentUrl, targetHost)) {
      return;
    }

    lastBody = (await maybeWithTimeout(page.locator("body").innerText({ timeout: 1000 }).catch(() => ""), 2000)) ?? "";
    if (lastBody.trim() && !(parsed?.host === targetHost && isLoginOrOauthCallbackPlumbingPath(parsed.pathname))) {
      return;
    }

    if (!reloadedBlankLoginPage && parsed && isLoginOrOauthCallbackPlumbingPath(parsed.pathname)) {
      reloadedBlankLoginPage = true;
      await maybeWithTimeout(page.reload({ waitUntil: "commit", timeout: 10000 }).catch(() => undefined), 12000);
      await page.waitForTimeout(1000);
      continue;
    }

    await page.waitForTimeout(500);
  }

  if (isTargetLoginOrOauthPlumbingPage(page.url(), targetHost)) {
    throw new Error(
      [
        `OIDC login did not leave target login plumbing page: ${page.url()}`,
        `body:\n${bodySnippetForError(lastBody) || "<empty>"}`
      ].join("\n")
    );
  }
}

async function locatorVisible(locator: ReturnType<Page["locator"]>): Promise<boolean> {
  return (await maybeWithTimeout(locator.isVisible().catch(() => false), BROWSER_POLL_TIMEOUT_MS)) ?? false;
}

async function locatorDisabled(locator: ReturnType<Page["locator"]>): Promise<boolean> {
  return (await maybeWithTimeout(locator.isDisabled().catch(() => false), BROWSER_POLL_TIMEOUT_MS)) ?? false;
}

async function typeInto(page: Page, selector: string, value: string): Promise<void> {
  let actual = "";
  let sawExpectedValue = false;
  const deadline = Date.now() + BROWSER_INPUT_TOTAL_TIMEOUT_MS;
  for (let attempt = 1; Date.now() < deadline && attempt <= 5; attempt += 1) {
    const locator = page.locator(selector).first();
    const visible = await maybeWithTimeout(
      locator.waitFor({ state: "visible", timeout: BROWSER_INPUT_ATTEMPT_TIMEOUT_MS }).then(() => true).catch(() => false),
      BROWSER_INPUT_ATTEMPT_TIMEOUT_MS + 1000
    );
    if (!visible) {
      await page.waitForTimeout(500);
      continue;
    }

    const editable = await waitForEditableInput(locator);
    if (!editable) {
      await page.waitForTimeout(500);
      continue;
    }

    const clicked = await maybeWithTimeout(
      locator.click({ timeout: BROWSER_INPUT_ATTEMPT_TIMEOUT_MS }).then(() => true).catch(() => false),
      BROWSER_INPUT_ATTEMPT_TIMEOUT_MS + 1000
    );
    if (!clicked) {
      await page.waitForTimeout(500);
      continue;
    }

    await locator.fill("", { timeout: BROWSER_INPUT_ATTEMPT_TIMEOUT_MS }).catch(() => undefined);
    await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
    await locator.press("Backspace").catch(() => undefined);
    await locator.type(value, { delay: 5, timeout: BROWSER_INPUT_ATTEMPT_TIMEOUT_MS }).catch(() => undefined);
    const typedValue = await inputValueIfAvailable(locator);
    if (typedValue === undefined) {
      if (sawExpectedValue) {
        return;
      }
      await page.waitForTimeout(500);
      continue;
    }
    actual = typedValue;

    if (actual !== value) {
      await locator.fill(value, { timeout: BROWSER_INPUT_ATTEMPT_TIMEOUT_MS }).catch(() => undefined);
      const filledValue = await inputValueIfAvailable(locator);
      if (filledValue === undefined) {
        if (sawExpectedValue) {
          return;
        }
        await page.waitForTimeout(500);
        continue;
      }
      actual = filledValue;
    }

    await locator
      .evaluate((element) => {
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      })
      .catch(() => undefined);

    if (actual === value) {
      sawExpectedValue = true;
      await page.waitForTimeout(300);
      const settledValue = await inputValueIfAvailable(locator);
      if (settledValue === undefined) {
        return;
      }
      actual = settledValue;
    }

    if (actual === value) {
      sawExpectedValue = true;
      await locator.press("Tab").catch(() => undefined);
      await page.waitForTimeout(300);
      const blurredValue = await inputValueIfAvailable(locator);
      if (blurredValue === undefined) {
        return;
      }
      actual = blurredValue;
    }

    if (actual === value) {
      return;
    }

    await page.waitForTimeout(500);
  }

  const body = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
  throw new Error(
    [
      `failed to type stable value into ${selector}; final value length was ${actual.length}`,
      `current URL: ${page.url()}`,
      `body:\n${bodySnippetForError(body) || "<empty>"}`
    ].join("\n")
  );
}

async function inputValueIfAvailable(locator: ReturnType<Page["locator"]>): Promise<string | undefined> {
  return await maybeWithTimeout(locator.inputValue().catch(() => undefined), BROWSER_POLL_TIMEOUT_MS);
}

async function waitForEditableInput(locator: ReturnType<Page["locator"]>): Promise<boolean> {
  const deadline = Date.now() + BROWSER_INPUT_ATTEMPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await maybeWithTimeout(
      locator
        .evaluate((element) => {
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
            return false;
          }
          return !element.disabled && !element.readOnly;
        })
        .catch(() => false),
      BROWSER_POLL_TIMEOUT_MS
    );
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

function submitControlSelectors(labels: string[]): string[] {
  const escapedLabels = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const labelPattern = escapedLabels.join("|");
  return [
    '[data-testid="submit-button"]',
    'button[type="submit"]',
    'input[type="submit"]',
    'input[type="button"]',
    ...labels.flatMap((label) => [
      `button:has-text("${label}")`,
      `[role="button"]:has-text("${label}")`,
      `input[type="submit"][value="${label}"]`,
      `input[type="button"][value="${label}"]`
    ]),
    `text=/^\\s*(${labelPattern})\\s*$/i`
  ];
}

async function waitForEnabledWithin(page: Page, selectors: string[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locatorVisible(locator)) && !(await locatorDisabled(locator))) {
        return true;
      }
    }

    await page.waitForTimeout(250);
  }

  return false;
}

async function submitForm(page: Page, buttonSelectors: string[]): Promise<void> {
  await clickFirst(page, buttonSelectors);
}

async function submitIdentityForm(page: Page, inputSelector: string, buttonSelectors: string[]): Promise<void> {
  const beforeUrl = page.url();
  const input = page.locator(inputSelector).first();

  await input.focus().catch(() => undefined);
  await input.press("Enter").catch(() => undefined);
  await page.waitForTimeout(750);
  if (await identitySubmissionAdvanced(page, beforeUrl, inputSelector)) {
    return;
  }

  if (await waitForEnabledWithin(page, buttonSelectors, 1000)) {
    await clickFirstVisible(page, buttonSelectors).catch(() => false);
    await page.waitForTimeout(750);
    if (await identitySubmissionAdvanced(page, beforeUrl, inputSelector)) {
      return;
    }
  }

  await domSubmitIdentityForm(page, inputSelector, buttonSelectors);
  await page.waitForTimeout(1000);
  if (await identitySubmissionAdvanced(page, beforeUrl, inputSelector)) {
    return;
  }

  await input.press("Enter").catch(() => undefined);
}

async function identitySubmissionAdvanced(page: Page, beforeUrl: string, inputSelector: string): Promise<boolean> {
  if (page.url() !== beforeUrl) {
    return true;
  }

  return !(await locatorVisible(page.locator(inputSelector).first()));
}

async function domSubmitIdentityForm(page: Page, inputSelector: string, buttonSelectors: string[]): Promise<void> {
  await page
    .locator(inputSelector)
    .first()
    .evaluate(
      (element, selectors) => {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          return;
        }

        element.focus();
        const submitFromKnownSelector = selectors
          .filter((selector) => !selector.startsWith("text=") && !selector.includes(":has-text("))
          .map((selector) => {
            try {
              return document.querySelector(selector);
            } catch {
              return undefined;
            }
          })
          .find((candidate): candidate is HTMLButtonElement | HTMLInputElement => {
            if (!(candidate instanceof HTMLButtonElement || candidate instanceof HTMLInputElement) || candidate.disabled) {
              return false;
            }
            const style = getComputedStyle(candidate);
            return style.visibility !== "hidden" && style.display !== "none";
          });
        const submit =
          submitFromKnownSelector ??
          Array.from(document.querySelectorAll("button,input"))
            .find((candidate): candidate is HTMLButtonElement | HTMLInputElement => {
              if (!(candidate instanceof HTMLButtonElement || candidate instanceof HTMLInputElement) || candidate.disabled) {
                return false;
              }
              const text = `${candidate.textContent ?? ""} ${candidate.value ?? ""}`.toLowerCase();
              return candidate.type === "submit" || text.includes("continue") || text.includes("next") || text.includes("sign in");
            });
        if (submit) {
          submit.click();
          return;
        }

        const form = element.closest("form");
        if (form && typeof form.requestSubmit === "function") {
          form.requestSubmit();
          return;
        }
        form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      },
      buttonSelectors
    )
    .catch(() => undefined);
}

async function waitForUserFacingBody(page: Page, markers: readonly string[], label: string): Promise<void> {
  const deadline = Date.now() + BROWSER_WAIT_TIMEOUT_MS;
  let lastBody = "";
  let blankSince = 0;
  let lastBlankReload = 0;
  let blankReloads = 0;

  while (Date.now() < deadline) {
    await maybeWithTimeout(page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined), 4000);
    const body = (await maybeWithTimeout(page.locator("body").innerText({ timeout: 1000 }).catch(() => ""), 2000)) ?? "";
    lastBody = body;
    if (bodyContainsHttpErrorText(body)) {
      throw new Error(`${label} rendered an HTTP error page:\n${bodySnippetForError(body)}`);
    }
    if (bodyContainsAnyMarker(body, markers)) {
      return;
    }

    const now = Date.now();
    if (body.trim()) {
      blankSince = 0;
    } else {
      blankSince ||= now;
      if (blankReloads < 3 && now - blankSince > 5000 && now - lastBlankReload > 5000) {
        blankReloads += 1;
        lastBlankReload = now;
        await maybeWithTimeout(page.reload({ waitUntil: "commit", timeout: 10000 }).catch(() => undefined), 12000);
        await page.waitForTimeout(1000);
        continue;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`${label} did not render expected UI markers; body:\n${bodySnippetForError(lastBody) || "<empty>"}`);
}

async function readPageBody(page: Page, timeoutMs = BROWSER_METADATA_TIMEOUT_MS): Promise<string> {
  return (await maybeWithTimeout(page.locator("body").innerText({ timeout: 1000 }).catch(() => ""), timeoutMs)) ?? "";
}

async function expectedTargetAlreadyReached(page: Page, targetHost: string, expected: LoginExpectation): Promise<boolean> {
  const body = await readPageBody(page, BROWSER_POLL_TIMEOUT_MS);
  if (expected === "deny" && bodyContainsDenialText(body)) {
    return true;
  }
  if (!isTargetApplicationPage(page.url(), targetHost)) {
    return false;
  }
  if (expected === "allow") {
    return true;
  }
  throw new Error(formatDeniedTargetRouteFailure(page.url(), body));
}

async function finishBrowserLogin(
  page: Page,
  screenshotPath: string,
  options: LoginOptions
): Promise<{ finalUrl: string; screenshotPath: string; bodyText: string; title: string }> {
  await page.waitForLoadState("domcontentloaded", { timeout: BROWSER_WAIT_TIMEOUT_MS }).catch(() => undefined);
  if (options.postLoginBodyMarkers) {
    await waitForUserFacingBody(page, options.postLoginBodyMarkers, options.postLoginLabel || "target");
  }
  await maybeWithTimeout(page.screenshot({ path: screenshotPath, fullPage: false }).then(() => undefined), BROWSER_SCREENSHOT_TIMEOUT_MS).catch(
    () => undefined
  );
  const finalUrl = page.url();
  const title = (await maybeWithTimeout(page.title().catch(() => ""), BROWSER_METADATA_TIMEOUT_MS)) ?? "";
  const bodyText = await readPageBody(page);
  return { finalUrl, screenshotPath, bodyText, title };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string | (() => string)): Promise<T> {
  let timer: Timer | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${typeof label === "function" ? label() : label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function maybeWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: Timer | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function waitForReturnToTargetHost(
  page: Page,
  targetHost: string,
  userEmail: string,
  expected: LoginExpectation
): Promise<void> {
  const deadline = Date.now() + BROWSER_WAIT_TIMEOUT_MS;
  let lastResubmit = 0;
  let lastAccountSelectionClick = 0;
  let lastConsentClick = 0;

  while (Date.now() < deadline) {
    const currentUrl = page.url();
    const body = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    const normalizedBody = body.toLowerCase();

    if (expected === "deny" && bodyContainsDenialText(body)) {
      return;
    }

    if (isTargetApplicationPage(currentUrl, targetHost)) {
      if (expected === "allow") {
        return;
      }
      throw new Error(formatDeniedTargetRouteFailure(currentUrl, body));
    }

    const onAccountSelectionStep =
      currentUrl.includes("/ui/v2/login/accounts") ||
      (normalizedBody.includes("select the account") && normalizedBody.includes(userEmail.toLowerCase()));

    if (onAccountSelectionStep) {
      const now = Date.now();
      if (now - lastAccountSelectionClick > 5000 && (await clickAccountSelection(page, userEmail))) {
        lastAccountSelectionClick = now;
        await page.waitForTimeout(1500);
        continue;
      }
    }

    if (
      normalizedBody.includes("password is wrong") ||
      normalizedBody.includes("user not found") ||
      normalizedBody.includes("invalid password") ||
      normalizedBody.includes("invalid login") ||
      normalizedBody.includes("login failed")
    ) {
      throw new Error(`ZITADEL login failed before returning to ${targetHost}\nbody:\n${bodySnippetForError(body)}`);
    }

    const now = Date.now();
    if (now - lastConsentClick > 5000 && (await clickFirstVisible(page, CONSENT_SUBMIT_SELECTORS).catch(() => false))) {
      lastConsentClick = now;
      await page.waitForTimeout(1500);
      continue;
    }

    const remainingMs = deadline - Date.now();
    const onPasswordStep =
      currentUrl.includes("/ui/v2/login/password") ||
      (normalizedBody.includes("password") && normalizedBody.includes("reset password"));

    if (onPasswordStep && Date.now() - lastResubmit > 5000 && remainingMs < BROWSER_WAIT_TIMEOUT_MS - 5000) {
      const passwordInput = page.locator('[data-testid="password-text-input"], input[name="password"], input[type="password"]').first();
      if (await passwordInput.isVisible().catch(() => false)) {
        await passwordInput.press("Enter").catch(() => undefined);
        await clickFirst(page, PASSWORD_SUBMIT_SELECTORS).catch(() => undefined);
        lastResubmit = Date.now();
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`timed out waiting to return to target host ${targetHost} from ZITADEL`);
}

async function clickAccountSelection(page: Page, userEmail: string): Promise<boolean> {
  const encodedEmail = encodeURIComponent(userEmail);
  const hrefSelectors = [`a[href*="loginName=${encodedEmail}"]`, `a[href*="${encodedEmail}"]`];

  for (const selector of hrefSelectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click().catch(() => undefined);
      return true;
    }
  }

  for (const role of ["link", "button"] as const) {
    const locator = page.getByRole(role, { name: new RegExp(userEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click({ force: true }).catch(() => undefined);
      return true;
    }
  }

  const accountCardClick = await accountSelectionClickPoint(page, userEmail);
  if (accountCardClick) {
    await page.mouse.click(accountCardClick.x, accountCardClick.y);
    await page.waitForTimeout(500);
    if (!page.url().includes("/ui/v2/login/accounts")) {
      return true;
    }
  }

  const textTargets = [userEmail, userEmail.split("@")[0] ?? userEmail];
  for (const text of textTargets) {
    const candidates = page.getByText(text, { exact: false });
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const textLocator = candidates.nth(index);
      if (!(await textLocator.isVisible().catch(() => false))) {
        continue;
      }

      const clickableAncestor = textLocator.locator("xpath=ancestor-or-self::*[self::a or self::button or @role='button' or @tabindex][1]").first();
      if (await clickableAncestor.isVisible().catch(() => false)) {
        await clickableAncestor.click({ force: true }).catch(() => undefined);
        return true;
      }

      await textLocator.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(500);
      if (!page.url().includes("/ui/v2/login/accounts")) {
        return true;
      }

      const clickableCard = textLocator.locator("xpath=ancestor::div[1]").first();
      const cardBox = await clickableCard.boundingBox().catch(() => null);
      if (cardBox) {
        await page.mouse.click(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
        await page.waitForTimeout(500);
        if (!page.url().includes("/ui/v2/login/accounts")) {
          return true;
        }
      }

      const textBox = await textLocator.boundingBox().catch(() => null);
      if (textBox) {
        await page.mouse.click(textBox.x + textBox.width / 2, textBox.y + textBox.height / 2);
        await page.waitForTimeout(500);
        if (!page.url().includes("/ui/v2/login/accounts")) {
          return true;
        }
      }
    }
  }

  return false;
}

async function accountSelectionClickPoint(page: Page, userEmail: string): Promise<{ x: number; y: number } | undefined> {
  return await page
    .evaluate((email) => {
      const normalizedEmail = email.toLowerCase();
      const isVisible = (element: Element) => {
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
      };
      const candidateElements: Element[] = [];
      for (const element of document.querySelectorAll("a,button,[role='button'],[tabindex],div,li")) {
        const text = (element.textContent ?? "").toLowerCase();
        if (text.includes(normalizedEmail) && isVisible(element)) {
          candidateElements.push(element);
        }
      }

      const scored = candidateElements
        .map((element) => {
          const box = element.getBoundingClientRect();
          if (box.width < 120 || box.height < 32 || box.width > window.innerWidth * 0.9 || box.height > 240) {
            return undefined;
          }

          const style = window.getComputedStyle(element);
          let score = 0;
          if (element instanceof HTMLAnchorElement || element instanceof HTMLButtonElement) {
            score += 1000;
          }
          if (element.getAttribute("role") === "button") {
            score += 700;
          }
          if (element.hasAttribute("tabindex")) {
            score += 400;
          }
          if (style.cursor === "pointer") {
            score += 350;
          }
          if (box.width >= 250 && box.height >= 60) {
            score += 250;
          }
          score -= Math.abs(box.width - 360) / 10;
          score -= Math.abs(box.height - 96) / 5;
          return {
            score,
            x: box.left + box.width * 0.45,
            y: box.top + box.height / 2
          };
        })
        .filter((candidate): candidate is { score: number; x: number; y: number } => Boolean(candidate))
        .sort((left, right) => right.score - left.score);

      const target = scored[0];
      if (!target) {
        return undefined;
      }
      return { x: target.x, y: target.y };
    }, userEmail)
    .catch(() => undefined);
}

/** Runs a browser flow and preserves screenshots for post-failure inspection. */
export async function withBrowser<T>(
  outputDir: string,
  runFlow: (browser: Browser) => Promise<T>,
  options: { resolveHosts?: Record<string, string>; ignoreHTTPSErrors?: boolean; lifecycleTimeoutMs?: number } = {}
): Promise<T> {
  mkdirSync(outputDir, { recursive: true });
  const browser = await withTimeout(
    chromium.launch({
      headless: true,
      timeout: BROWSER_WAIT_TIMEOUT_MS,
      args: hostResolverRules(options.resolveHosts).map((rules) => `--host-resolver-rules=${rules}`)
    }),
    BROWSER_WAIT_TIMEOUT_MS,
    "browser launch"
  );
  try {
    return await withTimeout(runFlow(browser), options.lifecycleTimeoutMs ?? BROWSER_LIFECYCLE_TIMEOUT_MS, "browser lifecycle");
  } catch (error) {
    const diagnostics = await captureBrowserLifecycleDiagnostics(browser, outputDir);
    throw new Error(`${error instanceof Error ? error.message : String(error)}${diagnostics}`);
  } finally {
    await withCloseTimeout(browser.close());
  }
}

async function newBrowserContext(browser: Browser, options: LoginOptions): Promise<BrowserContext> {
  return await browser.newContext({ ignoreHTTPSErrors: shouldIgnoreHttpsErrors(options) });
}

async function withCloseTimeout(close: Promise<unknown>): Promise<void> {
  await maybeWithTimeout(close.then(() => undefined).catch(() => undefined), BROWSER_CLOSE_TIMEOUT_MS);
}

async function captureBrowserLifecycleDiagnostics(browser: Browser, outputDir: string): Promise<string> {
  const details: string[] = [];
  const contexts = browser.contexts();

  for (let contextIndex = 0; contextIndex < contexts.length; contextIndex += 1) {
    const context = contexts[contextIndex];
    const pages = context?.pages() ?? [];
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const page = pages[pageIndex];
      if (!page || page.isClosed()) {
        continue;
      }

      const screenshotPath = join(outputDir, `browser-lifecycle-timeout-${contextIndex + 1}-${pageIndex + 1}.png`);
      const screenshot = await maybeWithTimeout(
        page.screenshot({ path: screenshotPath, fullPage: true }).then(() => screenshotPath),
        BROWSER_CLOSE_TIMEOUT_MS
      ).catch(() => undefined);
      const body = (await maybeWithTimeout(page.locator("body").innerText({ timeout: 1000 }).then(bodySnippetForError), 3000).catch(() => "")) || "";

      details.push(
        [
          `lifecycle page ${contextIndex + 1}.${pageIndex + 1}: ${page.url()}`,
          screenshot ? `screenshot: ${screenshot}` : undefined,
          body ? `body:\n${body}` : undefined
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
  }

  return details.length > 0 ? `\n\n${details.join("\n\n")}` : "";
}

async function loginThroughZitadelWithBrowser(
  browser: Browser,
  url: string,
  user: OidcTestUser,
  options: LoginOptions
): Promise<{ finalUrl: string; screenshotPath: string; bodyText: string; title: string }> {
  const context = await newBrowserContext(browser, options);
  try {
    return await loginThroughZitadelWithContext(context, url, user, options);
  } finally {
    await withCloseTimeout(context.close());
  }
}

async function loginThroughZitadelWithContext(
  context: BrowserContext,
  url: string,
  user: OidcTestUser,
  options: LoginOptions
): Promise<{ finalUrl: string; screenshotPath: string; bodyText: string; title: string }> {
  const expected = options.expected ?? "allow";
  const screenshotPath = browserScreenshotPath(options.outputDir, url, user.email, expected, "success");
  const targetHost = new URL(url).host;
  let page: Page | undefined;
  let stage = "creating browser context";
  const browserEvents: string[] = [];

  try {
    stage = "opening browser page";
    page = await context.newPage();
    page.setDefaultTimeout(BROWSER_WAIT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(BROWSER_WAIT_TIMEOUT_MS);
    page.on("close", () => {
      browserEvents.push("page: closed");
      browserEvents.splice(0, Math.max(0, browserEvents.length - 30));
    });
    page.on("console", (message) => {
      browserEvents.push(`console:${message.type()}: ${message.text()}`);
      browserEvents.splice(0, Math.max(0, browserEvents.length - 30));
    });
    page.on("requestfailed", (request) => {
      browserEvents.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim());
      browserEvents.splice(0, Math.max(0, browserEvents.length - 30));
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        browserEvents.push(`response:${response.status()}: ${response.url()}`);
        browserEvents.splice(0, Math.max(0, browserEvents.length - 30));
      }
    });

    return await withTimeout(
      (async () => {
        stage = "opening target URL";
        await page.goto(url, { waitUntil: "commit", timeout: BROWSER_WAIT_TIMEOUT_MS });

        stage = "starting OIDC login if the target shows a login screen";
        await clickOidcStartIfNeeded(page, targetHost);
        if (await expectedTargetAlreadyReached(page, targetHost, expected)) {
          stage = "capturing already-authenticated target page";
          return await finishBrowserLogin(page, screenshotPath, options);
        }
        stage = "waiting for identity login document";
        await waitForIdentityLoginDocument(page, targetHost);
        stage = "waiting for username input";
        const emailSelector = await firstIdentityInput(page, USERNAME_INPUT_SELECTORS, targetHost);
        stage = "entering username";
        await typeInto(page, emailSelector, user.email);
        stage = "submitting username";
        await submitIdentityForm(page, emailSelector, USERNAME_SUBMIT_SELECTORS);

        stage = "waiting for password input after username submit";
        const passwordWait = await waitForPasswordInputAfterUsernameSubmit(page, emailSelector, user.email, targetHost);
        if (passwordWait.state === "target") {
          stage = `waiting for ${expected} return to target host`;
          await waitForReturnToTargetHost(page, targetHost, user.email, expected);
          stage = "capturing success page";
          return await finishBrowserLogin(page, screenshotPath, options);
        }
        stage = "entering password";
        await typeInto(page, passwordWait.selector, user.password);
        stage = "submitting password";
        await submitIdentityForm(page, passwordWait.selector, PASSWORD_SUBMIT_SELECTORS);

        stage = `waiting for ${expected} return to target host`;
        await waitForReturnToTargetHost(page, targetHost, user.email, expected);
        stage = "capturing success page";
        return await finishBrowserLogin(page, screenshotPath, options);
      })(),
      BROWSER_FLOW_TIMEOUT_MS,
      () => `browser login flow (${stage})`
    );
  } catch (error) {
    const failurePath = browserScreenshotPath(options.outputDir, url, user.email, expected, "failure");
    let failureScreenshot: string | undefined;
    if (page) {
      failureScreenshot = await maybeWithTimeout(
        page.screenshot({ path: failurePath, fullPage: true }).then(() => failurePath),
        BROWSER_CLOSE_TIMEOUT_MS
      ).catch(() => undefined);
    }
    const bodySnippet = page
      ? (await maybeWithTimeout(page.locator("body").innerText({ timeout: 1000 }).then(bodySnippetForError), 3000).catch(() => "")) || ""
      : "";
    const htmlSnippet = page
      ? (await maybeWithTimeout(page.content().then(bodySnippetForError), 3000).catch(() => "")) || ""
      : "";
    const finalUrl = page?.url() ?? "<page unavailable>";
    const detail = [`stage: ${stage}`, `url: ${finalUrl}`];
    if (failureScreenshot) {
      detail.push(`screenshot: ${failureScreenshot}`);
    }
    if (bodySnippet) {
      detail.push(`body:\n${bodySnippet}`);
    }
    if (htmlSnippet && htmlSnippet !== bodySnippet) {
      detail.push(`html:\n${htmlSnippet}`);
    }
    if (browserEvents.length > 0) {
      detail.push(`browser events:\n${browserEvents.join("\n")}`);
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail.join("\n\n")}`);
  } finally {
    if (page && !page.isClosed()) {
      await withCloseTimeout(page.close());
    }
  }
}

async function loginThroughZitadelWithBrowserRetry(
  browser: Browser,
  url: string,
  user: OidcTestUser,
  options: LoginOptions
): Promise<{ finalUrl: string; screenshotPath: string; bodyText: string; title: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= BROWSER_LOGIN_ATTEMPTS; attempt += 1) {
    try {
      return await loginThroughZitadelWithBrowser(browser, url, user, options);
    } catch (error) {
      lastError = error;
      if (attempt >= BROWSER_LOGIN_ATTEMPTS || !isRetryableBlankNavigationError(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

/** Completes the ZITADEL login flow and returns on the post-login target page. */
export async function loginThroughZitadel(
  url: string,
  user: OidcTestUser,
  options: LoginOptions
): Promise<{ finalUrl: string; screenshotPath: string; bodyText: string; title: string }> {
  const browserOptions = { resolveHosts: options.resolveHosts, ignoreHTTPSErrors: options.ignoreHTTPSErrors };
  const loginOptions = { ...options, ignoreHTTPSErrors: shouldIgnoreHttpsErrors(browserOptions) };
  return await withBrowser(
    options.outputDir,
    async (browser) => await loginThroughZitadelWithBrowserRetry(browser, url, user, loginOptions),
    browserOptions
  );
}

export function isRetryableBlankNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    (message.includes("net::ERR_ABORTED") &&
      (message.includes("body:\n<empty>") || message.includes("browser login flow") || message.includes("timed out"))) ||
    (
      (
        message.includes("none of the selectors were visible") ||
        message.includes("none of the identity selectors were visible") ||
        message.includes("none of the password selectors were visible after username submit")
      ) &&
      message.includes("body:\n<empty>") &&
      /https?:\/\/[^/\s]+\/ui\/v2\/login\//.test(message)
    ) ||
    (
      message.includes("browser login flow (entering username) timed out") &&
      /https?:\/\/[^/\s]+\/ui\/v2\/login\/loginname/.test(message)
    ) ||
    (
      message.includes("failed to type stable value into") &&
      /https?:\/\/[^/\s]+\/ui\/v2\/login\/loginname/.test(message)
    ) ||
    (
      message.includes("goto: Timeout") &&
      message.includes("stage: opening target URL") &&
      message.includes("url: about:blank")
    ) ||
    (
      message.includes("Target page, context or browser has been closed") &&
      message.includes("/ui/v2/login/") &&
      (
        message.includes("stage: waiting for identity login document") ||
        message.includes("stage: waiting for username input") ||
        message.includes("stage: entering username") ||
        message.includes("stage: waiting for password input") ||
        message.includes("stage: entering password")
      )
    )
  );
}

/** Verifies that OIDC gating returns the user to Cockpit’s own PAM login form. */
export async function expectCockpitLogin(url: string, user: OidcTestUser, outputDir: string): Promise<string> {
  const result = await loginThroughZitadel(url, user, { outputDir });
  const final = new URL(result.finalUrl);
  const target = new URL(url);
  if (final.host !== target.host) {
    throw new Error(`unexpected post-login cockpit host: ${result.finalUrl}`);
  }
  return result.screenshotPath;
}

/** Verifies that the Traefik dashboard becomes reachable after OIDC login. */
export async function expectTraefikDashboard(url: string, user: OidcTestUser, outputDir: string): Promise<string> {
  const result = await loginThroughZitadel(url, user, { outputDir });
  if (!result.finalUrl.includes("/dashboard")) {
    throw new Error(`unexpected Traefik dashboard URL: ${result.finalUrl}`);
  }
  return result.screenshotPath;
}

/** Verifies the Cockpit and Traefik management surfaces in one browser lifecycle. */
export async function expectManagementUi(
  manageUrl: string,
  proxyUrl: string,
  user: OidcTestUser,
  outputDir: string,
  options: { resolveIp?: string; resolveHosts?: Record<string, string> } = {}
): Promise<void> {
  const resolveHosts = {
    ...(options.resolveHosts ?? {}),
    ...(options.resolveIp
      ? {
          [new URL(manageUrl).hostname]: options.resolveIp,
          [new URL(proxyUrl).hostname]: options.resolveIp
        }
      : {})
  };
  const ignoreHTTPSErrors = shouldIgnoreHttpsErrors({ resolveHosts });
  await withBrowser(
    outputDir,
    async (browser) => {
      const cockpit = await loginThroughZitadelWithBrowserRetry(browser, manageUrl, user, {
        outputDir,
        postLoginBodyMarkers: COCKPIT_TEXT_MARKERS,
        postLoginLabel: "Cockpit",
        ignoreHTTPSErrors
      });
      const cockpitFinal = new URL(cockpit.finalUrl);
      const cockpitTarget = new URL(manageUrl);
      if (cockpitFinal.host !== cockpitTarget.host) {
        throw new Error(`unexpected post-login cockpit host: ${cockpit.finalUrl}`);
      }
      assertUserFacingPageBody(`${cockpit.title}\n${cockpit.bodyText}`, COCKPIT_TEXT_MARKERS, "Cockpit");

      const proxy = await loginThroughZitadelWithBrowserRetry(browser, proxyUrl, user, {
        outputDir,
        postLoginBodyMarkers: TRAEFIK_TEXT_MARKERS,
        postLoginLabel: "Traefik dashboard",
        ignoreHTTPSErrors
      });
      if (!proxy.finalUrl.includes("/dashboard")) {
        throw new Error(`unexpected Traefik dashboard URL: ${proxy.finalUrl}`);
      }
      assertUserFacingPageBody(`${proxy.title}\n${proxy.bodyText}`, TRAEFIK_TEXT_MARKERS, "Traefik dashboard");
    },
    {
      lifecycleTimeoutMs: browserLifecycleTimeoutForLoginTargets(2),
      resolveHosts: Object.keys(resolveHosts).length > 0 ? resolveHosts : undefined
    }
  );
}

/** Verifies the Cockpit, Traefik, and LXD management surfaces in one browser lifecycle. */
export async function expectManagementSurfaces(
  manageUrl: string,
  proxyUrl: string,
  lxdUrl: string,
  user: OidcTestUser,
  outputDir: string,
  options: { resolveIp?: string; resolveHosts?: Record<string, string> } = {}
): Promise<void> {
  const resolveHosts = {
    ...(options.resolveHosts ?? {}),
    ...(options.resolveIp
      ? {
          [new URL(manageUrl).hostname]: options.resolveIp,
          [new URL(proxyUrl).hostname]: options.resolveIp,
          [new URL(lxdUrl).hostname]: options.resolveIp
        }
      : {})
  };
  const ignoreHTTPSErrors = shouldIgnoreHttpsErrors({ resolveHosts });
  await withBrowser(
    outputDir,
    async (browser) => {
      const cockpit = await loginThroughZitadelWithBrowserRetry(browser, manageUrl, user, {
        outputDir,
        postLoginBodyMarkers: COCKPIT_TEXT_MARKERS,
        postLoginLabel: "Cockpit",
        ignoreHTTPSErrors
      });
      const cockpitFinal = new URL(cockpit.finalUrl);
      const cockpitTarget = new URL(manageUrl);
      if (cockpitFinal.host !== cockpitTarget.host) {
        throw new Error(`unexpected post-login cockpit host: ${cockpit.finalUrl}`);
      }
      assertUserFacingPageBody(`${cockpit.title}\n${cockpit.bodyText}`, COCKPIT_TEXT_MARKERS, "Cockpit");

      const proxy = await loginThroughZitadelWithBrowserRetry(browser, proxyUrl, user, {
        outputDir,
        postLoginBodyMarkers: TRAEFIK_TEXT_MARKERS,
        postLoginLabel: "Traefik dashboard",
        ignoreHTTPSErrors
      });
      if (!proxy.finalUrl.includes("/dashboard")) {
        throw new Error(`unexpected Traefik dashboard URL: ${proxy.finalUrl}`);
      }
      assertUserFacingPageBody(`${proxy.title}\n${proxy.bodyText}`, TRAEFIK_TEXT_MARKERS, "Traefik dashboard");

      const lxd = await loginThroughZitadelWithBrowserRetry(browser, lxdUrl, user, {
        outputDir,
        postLoginBodyMarkers: LXD_TEXT_MARKERS,
        postLoginLabel: "LXD UI",
        ignoreHTTPSErrors
      });
      const lxdFinal = new URL(lxd.finalUrl);
      const lxdTarget = new URL(lxdUrl);
      if (lxdFinal.host !== lxdTarget.host) {
        throw new Error(`unexpected post-login LXD host: ${lxd.finalUrl}`);
      }
      assertUserFacingPageBody(`${lxd.title}\n${lxd.bodyText}`, LXD_TEXT_MARKERS, "LXD UI");
    },
    {
      lifecycleTimeoutMs: browserLifecycleTimeoutForLoginTargets(3),
      resolveHosts: Object.keys(resolveHosts).length > 0 ? resolveHosts : undefined
    }
  );
}

/** Verifies that the public LXD UI completes OIDC login and renders an authenticated management view. */
export async function expectLxdUi(
  lxdUrl: string,
  user: OidcTestUser,
  outputDir: string,
  options: { resolveIp?: string; resolveHosts?: Record<string, string> } = {}
): Promise<void> {
  const resolveHosts = {
    ...(options.resolveHosts ?? {}),
    ...(options.resolveIp ? { [new URL(lxdUrl).hostname]: options.resolveIp } : {})
  };
  const result = await loginThroughZitadel(lxdUrl, user, {
    outputDir,
    resolveHosts: Object.keys(resolveHosts).length > 0 ? resolveHosts : undefined,
    postLoginBodyMarkers: LXD_TEXT_MARKERS,
    postLoginLabel: "LXD UI"
  });
  const final = new URL(result.finalUrl);
  const target = new URL(lxdUrl);
  if (final.host !== target.host) {
    throw new Error(`unexpected post-login LXD host: ${result.finalUrl}`);
  }
  assertUserFacingPageBody(`${result.title}\n${result.bodyText}`, LXD_TEXT_MARKERS, "LXD UI");
}

/** Verifies a protected published route for either allow or deny behavior. */
export async function expectProtectedRoute(
  url: string,
  user: OidcTestUser,
  expected: LoginExpectation,
  outputDir: string,
  bodyNeedle = "",
  options: { resolveIp?: string } = {}
): Promise<string> {
  const resolveHosts = options.resolveIp ? { [new URL(url).hostname]: options.resolveIp } : undefined;
  const result = await loginThroughZitadel(url, user, {
    outputDir,
    resolveHosts,
    expected,
    postLoginBodyMarkers: expected === "allow" && bodyNeedle ? [bodyNeedle] : undefined,
    postLoginLabel: "protected route"
  });
  if (expected === "allow") {
    if (bodyNeedle && !result.bodyText.includes(bodyNeedle)) {
      throw new Error(
        [
          `expected protected route body to include "${bodyNeedle}"`,
          `final URL: ${result.finalUrl}`,
          `body:\n${bodySnippetForError(result.bodyText) || "<empty>"}`
        ].join("\n")
      );
    }
    return result.screenshotPath;
  }

  if (!bodyContainsDenialText(result.bodyText)) {
    throw new Error("expected denied protected route to show a forbidden/denied page");
  }
  return result.screenshotPath;
}

type ProtectedRouteCheck = {
  url: string;
  user: OidcTestUser;
  expected: LoginExpectation;
  bodyNeedle?: string;
};

/** Verifies a protected route matrix while reusing the IdP browser session for the same user. */
export async function expectProtectedRouteMatrix(
  checks: ProtectedRouteCheck[],
  outputDir: string,
  options: { resolveIp?: string } = {}
): Promise<void> {
  if (checks.length === 0) {
    return;
  }

  const resolveIp = options.resolveIp;
  const resolveHosts: Record<string, string> | undefined = resolveIp
    ? Object.fromEntries(checks.map((check) => [new URL(check.url).hostname, resolveIp]))
    : undefined;
  const ignoreHTTPSErrors = shouldIgnoreHttpsErrors({ resolveHosts });

  await withBrowser(
    outputDir,
    async (browser) => {
      let context: BrowserContext | undefined;
      let contextUserEmail = "";
      try {
        for (const check of checks) {
          if (!context || contextUserEmail !== check.user.email) {
            if (context) {
              await withCloseTimeout(context.close());
            }
            context = await newBrowserContext(browser, { outputDir, resolveHosts, ignoreHTTPSErrors });
            contextUserEmail = check.user.email;
          }

          const result = await loginThroughZitadelWithContext(context, check.url, check.user, {
            outputDir,
            resolveHosts,
            expected: check.expected,
            ignoreHTTPSErrors,
            postLoginBodyMarkers: check.expected === "allow" && check.bodyNeedle ? [check.bodyNeedle] : undefined,
            postLoginLabel: "protected route"
          });

          if (check.expected === "allow") {
            if (check.bodyNeedle && !result.bodyText.includes(check.bodyNeedle)) {
              throw new Error(
                [
                  `expected protected route body to include "${check.bodyNeedle}"`,
                  `final URL: ${result.finalUrl}`,
                  `body:\n${bodySnippetForError(result.bodyText) || "<empty>"}`
                ].join("\n")
              );
            }
            continue;
          }

          if (!bodyContainsDenialText(result.bodyText)) {
            throw new Error("expected denied protected route to show a forbidden/denied page");
          }
        }
      } finally {
        if (context) {
          await withCloseTimeout(context.close());
        }
      }
    },
    {
      lifecycleTimeoutMs: browserLifecycleTimeoutForLoginTargets(checks.length),
      resolveHosts
    }
  );
}

function slugForPath(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "page";
}

export function browserScreenshotPath(
  outputDir: string,
  url: string,
  userEmail: string,
  expected: LoginExpectation,
  kind: BrowserArtifactKind
): string {
  return join(outputDir, `${slugForPath(url)}-${expected}-${slugForPath(userEmail)}-${kind}.png`);
}

export function bodyContainsDenialText(body: string): boolean {
  const normalized = body.toLowerCase();
  return DENIAL_TEXT_MARKERS.some((marker) => normalized.includes(marker));
}

export function bodyContainsHttpErrorText(body: string): boolean {
  const normalized = body.toLowerCase();
  return ERROR_TEXT_MARKERS.some((marker) => normalized.includes(marker));
}

export function bodyContainsAnyMarker(body: string, markers: readonly string[]): boolean {
  const normalized = body.toLowerCase();
  return markers.some((marker) => normalized.includes(marker.toLowerCase()));
}

function assertUserFacingPageBody(body: string, markers: readonly string[], label: string): void {
  if (bodyContainsHttpErrorText(body)) {
    throw new Error(`${label} rendered an HTTP error page:\n${bodySnippetForError(body)}`);
  }
  if (!bodyContainsAnyMarker(body, markers)) {
    throw new Error(`${label} did not render expected UI markers; body:\n${bodySnippetForError(body) || "<empty>"}`);
  }
}

export function isLoginOrOauthCallbackPlumbingPath(pathname: string): boolean {
  const normalized = pathname.toLowerCase();
  return (
    normalized.startsWith("/ui/v2/login") ||
    normalized.startsWith("/ui/login") ||
    normalized === "/oauth2" ||
    normalized.startsWith("/oauth2/") ||
    normalized === "/oidc" ||
    normalized.startsWith("/oidc/")
  );
}

export function isTargetApplicationPage(currentUrl: string, targetHost: string): boolean {
  const parsed = parseBrowserUrl(currentUrl);
  return Boolean(parsed && parsed.host === targetHost && !isLoginOrOauthCallbackPlumbingPath(parsed.pathname));
}

export function isTargetLoginOrOauthPlumbingPage(currentUrl: string, targetHost: string): boolean {
  const parsed = parseBrowserUrl(currentUrl);
  return Boolean(parsed && parsed.host === targetHost && isLoginOrOauthCallbackPlumbingPath(parsed.pathname));
}

export function isIdentityLoginInputPage(currentUrl: string, targetHost: string): boolean {
  const parsed = parseBrowserUrl(currentUrl);
  return Boolean(parsed && !(parsed.host === targetHost && isLoginOrOauthCallbackPlumbingPath(parsed.pathname)));
}

export function lxdOidcLoginUrlForSsoPage(currentUrl: string, body: string, targetHost: string): string | undefined {
  const parsed = parseBrowserUrl(currentUrl);
  if (!parsed || parsed.host !== targetHost || !parsed.pathname.toLowerCase().startsWith("/ui/login")) {
    return undefined;
  }

  const normalizedBody = body.toLowerCase();
  if (!normalizedBody.includes("login with sso") || !normalizedBody.includes("canonical lxd")) {
    return undefined;
  }

  return `${parsed.origin}/oidc/login`;
}

export function formatDeniedTargetRouteFailure(finalUrl: string, body: string): string {
  return [
    "expected denied protected route to show a denial page, but the browser reached the target host without denial text",
    `final url: ${finalUrl}`,
    `body:\n${bodySnippetForError(body) || "<empty>"}`
  ].join("\n");
}

function bodySnippetForError(body: string): string {
  return body.slice(0, BODY_SNIPPET_LENGTH);
}

function parseBrowserUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function hostResolverRules(resolveHosts?: Record<string, string>): string[] {
  const entries = Object.entries(resolveHosts ?? {});
  if (entries.length === 0) {
    return [];
  }
  const mappings = entries.map(([host, ip]) => `MAP ${host} ${ip}`);
  mappings.push("EXCLUDE localhost");
  return [mappings.join(",")];
}
