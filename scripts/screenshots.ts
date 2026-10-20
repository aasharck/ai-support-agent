// Takes the README screenshots in mock mode: a cited answer, a refusal, a tool call.
// Runs against a production build (`npm run screenshots` builds first) and uses your
// installed Google Chrome, so Playwright doesn't download a browser.
// Set CHROME_PATH to use a different Chromium-based browser.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const PORT = 3130;
const URL = `http://localhost:${PORT}`;
const OUT = "docs/screenshots";
const SHOTS = [
  { file: "1-cited-answer.png", question: "How often should I descale the Bloom One?" },
  { file: "2-refusal.png", question: "Do you offer a student discount?" },
  { file: "3-tool-call.png", question: "Where is my order TB-10042? My email is sam@example.com" },
];

if (!existsSync(".next/BUILD_ID")) throw new Error("Run `npm run build` first (or use `npm run screenshots`).");

// Mock mode, in-memory database, whatever is in the shell.
const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  env: { ...process.env, ANTHROPIC_API_KEY: "", DATABASE_URL: "", VOYAGE_API_KEY: "", NEXT_TELEMETRY_DISABLED: "1" },
  stdio: "ignore",
});

try {
  for (let i = 0; ; i++) {
    if (await fetch(`${URL}/api/status`).then((r) => r.ok, () => false)) break;
    if (i > 60) throw new Error("server didn't start");
    await new Promise((r) => setTimeout(r, 500));
  }
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1, colorScheme: "light" });
  for (const shot of SHOTS) {
    const page = await context.newPage();
    await page.goto(URL);
    await page.getByText("Knowledge base").waitFor();
    await page.getByLabel("Your question").fill(shot.question);
    await page.getByRole("button", { name: "Send" }).click();
    await page.locator(".msg.assistant .meta").waitFor();
    await page.getByText("Retrieved for the last question").waitFor();
    await page.screenshot({ path: `${OUT}/${shot.file}` });
    console.log(`${OUT}/${shot.file}`);
    await page.close();
  }
  await browser.close();
} finally {
  server.kill();
}
