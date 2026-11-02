import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";

const out = "test-results/sidebar-menu-placement";
await mkdir(out, { recursive: true });
await build({ entryPoints: ["e2e/sidebar-menu-placement.fixture.jsx"], bundle: true, platform: "browser",
  outfile: `${out}/fixture.js`, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "actual-sidebar-row", setup(bundler) {
    bundler.onLoad({ filter: /components[/\\]SessionSidebar\.tsx$/ }, async ({ path }) => ({ loader: "tsx",
      contents: `${await readFile(path,"utf8")}\nexport { SessionItem as SidebarSessionFixture };` }));
  } }], logLevel: "warning",
});
const js = await readFile(`${out}/fixture.js`);
const css = (await Promise.all(["app/globals.css", "app/settings.css", "app/native-theme.css"]
  .map(path => readFile(path,"utf8")))).map(text => text.replace(/^@import[^;]*;/gm, "")).join("\n");
const server = createServer((req,res) => {
  if (req.url === "/fixture.js") { res.setHeader("Content-Type","text/javascript"); res.end(js); return; }
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
    html,body,#root{margin:0;width:100%;height:100%}button{font:inherit}
    </style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
});
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

/** The menu must sit fully inside the window, and it must open upward when
 *  the space below its anchor cannot hold it. */
async function assertMenuFitsUpwards(page, menu, anchor, label) {
  const geometry = await page.evaluate(({ menu, anchor }) => {
    const panel = document.querySelector(menu);
    const box = panel.getBoundingClientRect();
    const trigger = document.querySelector(anchor).getBoundingClientRect();
    return {
      top: box.top, bottom: box.bottom, left: box.left, right: box.right,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      anchorTop: trigger.top, anchorBottom: trigger.bottom,
    };
  }, { menu, anchor });
  assert.ok(geometry.top >= 0, `${label}: menu must not leave the top of the window ${JSON.stringify(geometry)}`);
  assert.ok(geometry.bottom <= geometry.viewportHeight, `${label}: menu must not leave the bottom of the window ${JSON.stringify(geometry)}`);
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewportWidth, `${label}: menu must stay inside the window ${JSON.stringify(geometry)}`);
  assert.ok(geometry.bottom <= geometry.anchorTop + 1, `${label}: menu must open upward when the space below is too small ${JSON.stringify(geometry)}`);
  return geometry;
}

try {
  for (const theme of ["light", "dark"]) for (const locale of ["zh-CN", "en"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 620 }, colorScheme: theme });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(({ theme, locale }) => {
      localStorage.setItem("pi-locale", locale);
      localStorage.setItem("pi-theme", theme);
    }, { theme, locale });
    await page.goto(base);

    // The session row's "…" menu, opened on a row near the bottom edge.
    const row = page.locator(".session-item").first();
    await row.hover();
    await row.locator(".session-item-more").click();
    const sessionMenu = page.locator(".session-item-menu");
    await sessionMenu.waitFor();
    await assertMenuFitsUpwards(page, ".session-item-menu", ".session-item-more", "session menu");
    const deleteItem = sessionMenu.getByRole("menuitem", { name: locale === "zh-CN" ? "删除" : "Delete" });
    await deleteItem.waitFor();
    assert.ok(await deleteItem.isVisible(), "the delete entry must be reachable");
    await page.screenshot({ path: `${out}/session-menu-${theme}-${locale}.png` });
    await page.keyboard.press("Escape");
    await sessionMenu.waitFor({ state: "detached" });

    // The project row's "…" menu, opened on a row near the bottom edge.
    await page.locator("#project-more").click();
    const projectMenu = page.locator(".sidebar-project-context-menu");
    await projectMenu.waitFor();
    await assertMenuFitsUpwards(page, ".sidebar-project-context-menu", "#project-more", "project menu");
    const archiveItem = projectMenu.getByRole("menuitem", { name: locale === "zh-CN" ? "移到存档" : "Move to archive" });
    await archiveItem.waitFor();
    assert.ok(await archiveItem.isVisible(), "the archive-project entry must be reachable");
    await page.screenshot({ path: `${out}/project-menu-${theme}-${locale}.png` });

    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("PASS: sidebar menus flip above their anchor and keep every entry reachable");
} finally {
  await browser.close();
  server.close();
}
