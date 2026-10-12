import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const channel = "44444444-4444-4444-8444-444444444444";
async function login(page: Page, email = "alice@acme.test") {
  await page.goto(`/?channel=${channel}`);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Development123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "General standard", exact: true }),
  ).toBeVisible();
}
test("independent users exchange persisted messages, react, and recover a draft", async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  const alice = await a.newPage(),
    bob = await b.newPage();
  await login(alice);
  await login(bob, "bob@acme.test");
  const text = `Browser delivery ${Date.now()}`;
  await alice.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await alice
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(bob.getByText(text, { exact: true })).toBeVisible({
    timeout: 10000,
  });
  const message = bob.locator("article").filter({ hasText: text });
  await message.hover();
  await message
    .getByRole("button", { name: "Like message by Alice Morgan" })
    .click();
  await expect(
    alice
      .locator("article")
      .filter({ hasText: text })
      .getByRole("button", { name: "React 👍" }),
  ).toBeVisible();
  await bob
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("A persistent draft");
  await expect
    .poll(async () => {
      const r = await b.request.get(
        `http://localhost:4100/v1/channels/${channel}/draft`,
      );
      return (await r.json()).body;
    })
    .toBe("A persistent draft");
  await bob.reload();
  await expect(
    bob.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("A persistent draft");
  await bob.getByRole("textbox", { name: "Message", exact: true }).fill("");
  await alice.reload();
  await expect(alice.getByText(text, { exact: true })).toBeVisible();
  await a.close();
  await b.close();
});
test("private board task and form persist through UI", async ({ page }) => {
  await login(page);
  await page
    .getByRole("button", { name: "Launch planning", exact: false })
    .first()
    .click();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "New task" }).click();
  const title = `Browser task ${Date.now()}`;
  await page.getByRole("textbox", { name: "Title", exact: true }).fill(title);
  await page.getByLabel("Assign to").selectOption({ label: "Bob Chen" });
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByLabel(`Task status for ${title}`).selectOption("done");
  await expect(
    page
      .locator(".task-column")
      .filter({
        has: page.getByRole("heading", { name: "Done", exact: false }),
      })
      .getByRole("heading", { name: title }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Forms", exact: true }).click();
  await page.getByRole("button", { name: "New form" }).click();
  const formTitle = `Browser survey ${Date.now()}`;
  await page
    .getByRole("textbox", { name: "Title", exact: true })
    .fill(formTitle);
  await page
    .getByLabel("Questions (one per line)")
    .fill("What should we improve?");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: formTitle })).toBeVisible();
  const form = page.locator("form.card").filter({ hasText: formTitle });
  await form.getByLabel("What should we improve?").fill("Release notes");
  await form.getByRole("button", { name: "Submit response" }).click();
  await expect(form.getByText("Your response is saved.")).toBeVisible();
});
test("tenant switching clears conversation data; service limitations explicit", async ({
  page,
}) => {
  await login(page);
  await page
    .getByLabel("WORKSPACE", { exact: true })
    .selectOption({ label: "Northstar Labs" });
  await expect(
    page.getByRole("heading", { name: "Your next conversation starts here" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "General standard", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Calls", exact: true }).click();
  await expect(
    page.getByText("Media service not configured", { exact: true }),
  ).toBeVisible();
});
test("workspace accessibility and responsive overflow", async ({ page }) => {
  await login(page);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
  await page.screenshot({
    path: "test-results/workspace-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/workspace-mobile.png",
    fullPage: true,
  });
});

test("separate windows synchronize and logout clears both", async ({
  page,
  context,
}) => {
  await login(page);
  const opened = context.waitForEvent("page");
  await page
    .getByRole("button", { name: "Open conversation in separate window" })
    .click();
  const popup = await opened;
  await expect(
    popup.getByRole("heading", { name: "General standard", exact: true }),
  ).toBeVisible();
  const text = `Popout synchronization ${Date.now()}`;
  await popup.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await popup
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(page.getByText(text, { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    popup.getByRole("heading", { name: "A little more connected." }),
  ).toBeVisible();
});
test("guest adds and deletes an authorized document", async ({
  page,
}) => {
  await login(page, "guest@partner.test");
  await page
    .locator(".tabs")
    .getByRole("button", { name: "Files", exact: true })
    .click();
  const filename = `guest-note-${Date.now()}.txt`;
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name: filename,
      mimeType: "text/plain",
      buffer: Buffer.from("Guest document test"),
    });
  const row = page.locator(".file-row").filter({ hasText: filename });
  await expect(row).toBeVisible();
  await expect(row.getByText(/quarantined|ready/)).toBeVisible();
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(row).toHaveCount(0);
});

test("lost acceptance response survives navigation and reload, then retries without duplication", async ({
  page,
}) => {
  await login(page);
  const text = `Lost acknowledgement ${Date.now()}`;
  const pattern = `**/v1/channels/${channel}/messages`;
  await page.route(pattern, async (route) => {
    if (route.request().method() === "POST") {
      await route.fetch();
      await route.abort("failed");
      await page.unroute(pattern);
    } else await route.continue();
  });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry safely" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Launch planning", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry safely" })).toHaveCount(0);
  await page.goto(`/?channel=${channel}`);
  await expect(page.getByRole("button", { name: "Retry safely" })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry safely" })).toBeEnabled();
  const nextDraft = `Separate draft ${Date.now()}`;
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(nextDraft);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry safely" }).click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(nextDraft);
  await expect(page.locator("article").filter({ hasText: text })).toHaveCount(
    1,
  );
  await expect(page.getByRole("button", { name: "Retry safely" })).toHaveCount(
    0,
  );
});
test("offline draft is retained and syncs after reconnection", async ({
  page,
  context,
}) => {
  await login(page);
  const draft = `Offline draft ${Date.now()}`;
  await context.setOffline(true);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(draft);
  await expect(
    page.getByText("Draft not synced — keep this window open", { exact: true }),
  ).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText("Live", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect
    .poll(async () => {
      const r = await context.request.get(
        `http://localhost:4100/v1/channels/${channel}/draft`,
      );
      return (await r.json()).body;
    })
    .toBe(draft);
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue(draft);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("");
});

test("dark theme remains accessible and persists", async ({
  page,
  context,
  browser,
}) => {
  console.log(`Browser under test: ${browser.version()}`);
  await login(page);
  try {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Appearance").selectOption("dark");
    await page
      .getByRole("button", { name: "Save preferences", exact: true })
      .click();
    await expect(
      page.getByText("Preferences saved.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(result.violations).toEqual([]);
    await page.screenshot({
      path: "test-results/workspace-dark.png",
      fullPage: true,
    });
  } finally {
    const r = await context.request.get("http://localhost:4100/v1/session");
    const { user } = await r.json();
    await context.request.patch("http://localhost:4100/v1/profile", {
      headers: { origin: "http://localhost:3100" },
      data: {
        name: user.name,
        title: user.title,
        timezone: user.timezone,
        status: user.status,
        preferences: { ...user.preferences, theme: "light" },
      },
    });
  }
});

test("untrusted message markup renders as text", async ({ page }) => {
  await login(page);
  const text = `Markup ${Date.now()} <img data-probe src=x onerror="document.body.dataset.injected=1">`;
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.locator("img[data-probe]")).toHaveCount(0);
  expect(await page.locator("body").getAttribute("data-injected")).toBeNull();
});

test("logout clears pending text; another identity cannot inherit it", async ({ page }) => {
  await login(page);
  await page.route(`**/v1/channels/${channel}/messages`, async route => {
    if (route.request().method() === "POST") await route.abort();
    else await route.continue();
  });
  const text = `Private pending operation ${Date.now()}`;
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry safely" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A little more connected." })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("concord.pending-messages.v1"))).toBeNull();
  await login(page, "bob@acme.test");
  await expect(page.getByRole("button", { name: "Retry safely" })).toHaveCount(0);
  await expect(page.getByText(text, { exact: true })).toHaveCount(0);
});

test("blocked browser storage prevents transmission and explains recovery", async ({ page }) => {
  await login(page);
  let posts = 0;
  page.on("request", request => {
    if (request.method() === "POST" && request.url().endsWith(`/channels/${channel}/messages`)) posts++;
  });
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === "concord.pending-messages.v1") throw new DOMException("Quota exceeded", "QuotaExceededError");
      return set.call(this, key, value);
    };
  });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(`Blocked send ${Date.now()}`);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "No message was sent" })).toBeVisible();
  expect(posts).toBe(0);
});

test("an accepted send remains accepted when the draft update fails", async ({ page }) => {
  await login(page);
  await page.route(`**/v1/channels/${channel}/draft`, async route => {
    if (route.request().method() === "PUT" && route.request().postDataJSON().body === "") await route.abort();
    else await route.continue();
  });
  const text = `Accepted despite refresh failure ${Date.now()}`;
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator("article").filter({ hasText: text })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Retry safely" })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("concord.pending-messages.v1"))).toBeNull();
});

test("malformed recovery storage can be cleared through Help without signing out", async ({ page }) => {
  await login(page);
  await page.evaluate(() => sessionStorage.setItem("concord.pending-messages.v1", "invalid-json"));
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Pending-message storage is invalid" })).toBeVisible();
  await page.getByRole("button", { name: "Help and service status" }).click();
  await page.getByRole("button", { name: "Clear all local pending sends" }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("concord.pending-messages.v1"))).toBeNull();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const text = `Storage recovered ${Date.now()}`;
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator("article").filter({ hasText: text })).toHaveCount(1);
});

test("formatted composition previews, delivers to another user and edits without changing legacy text", async ({browser}) => {
  const a = await browser.newContext(), b = await browser.newContext();
  try {
    const alice = await a.newPage(), bob = await b.newPage();
    await login(alice); await login(bob,"bob@acme.test");
    const marker = `Formatting ${Date.now()}`;
    const input = alice.getByRole("textbox",{name:"Message",exact:true});
    await input.fill(marker);
    await input.selectText();
    await alice.getByRole("button",{name:"Bold",exact:true}).click();
    await expect(input).toHaveValue(`**${marker}**`);
    const source = `**${marker}**\n\n*Emphasis* and \`inline code\`\n\n- First item\n- Second item\n\n[Documentation](https://example.com/docs)`;
    await input.fill(source);
    await alice.getByRole("button",{name:"Preview formatting",exact:true}).click();
    const preview = alice.getByRole("region",{name:"Message preview"});
    await expect(preview.locator("strong")).toHaveText(marker);
    await expect(preview.locator("li")).toHaveCount(2);
    await alice.getByRole("button",{name:"Send message",exact:true}).click();
    const received = bob.locator("article").filter({hasText:marker});
    await expect(received.locator(".formatted-message strong")).toContainText(marker);
    await expect(received.locator("em")).toHaveText("Emphasis");
    await expect(received.locator("code")).toHaveText("inline code");
    await expect(received.getByRole("link",{name:"Documentation"})).toHaveAttribute("href","https://example.com/docs");
    const sent = alice.locator("article").filter({hasText:marker});
    await sent.hover(); await sent.getByRole("button",{name:"Edit message",exact:true}).click();
    const editInput = alice.getByRole("dialog").getByRole("textbox",{name:"Message",exact:true});
    await editInput.fill(`${source}\n\n**Revised**`);
    await expect(editInput).toHaveValue(`${source}\n\n**Revised**`);
    await alice.getByRole("button",{name:"Save changes",exact:true}).click();
    await expect(received.locator("strong").last()).toHaveText("Revised");
    await bob.reload(); await expect(bob.locator("article").filter({hasText:marker}).locator("em")).toHaveText("Emphasis");
    const legacy = `**Literal ${Date.now()}**`;
    await a.request.post(`http://localhost:4100/v1/channels/${channel}/messages`,{headers:{origin:"http://localhost:3101"},data:{clientId:crypto.randomUUID(),body:legacy}});
    const literal = bob.locator("article").filter({hasText:legacy});
    await expect(literal.getByText(legacy,{exact:true})).toBeVisible();
    await expect(literal.locator(".plain-message strong")).toHaveCount(0);
    await bob.locator("article").filter({hasText:marker}).scrollIntoViewIfNeeded();
    await bob.screenshot({path:"docs/evidence/formatted-messages.png"});
  } finally { await a.close(); await b.close(); }
});

test("Markdown rejects executable URLs and remote embeds in preview and sent messages", async ({page}) => {
  await login(page);
  const marker = `Safety ${Date.now()}`;
  const requested: string[] = [];
  page.on("request",r=>{if(r.url().includes("tracking.invalid"))requested.push(r.url());});
  const source = `${marker}\n\n[script](javascript:alert(1)) [encoded](jav&#x61;script:alert(1)) [data](data:text/html,hi) [relative](/v1/session) [protocol](//tracking.invalid/x) [credentials](https://user:secret@tracking.invalid/x)\n\n![tracking](https://tracking.invalid/pixel)\n\n<img data-format-probe src="https://tracking.invalid/raw" onerror="document.body.dataset.injected=1">\n\n[Safe link](https://example.com/safe)`;
  await page.getByRole("textbox",{name:"Message",exact:true}).fill(source);
  await page.getByRole("button",{name:"Preview formatting",exact:true}).click();
  const preview = page.getByRole("region",{name:"Message preview"});
  await expect(preview.locator("a")).toHaveCount(1);
  await expect(preview.locator("img")).toHaveCount(0);
  await page.getByRole("button",{name:"Send message",exact:true}).click();
  const message = page.locator("article").filter({hasText:marker});
  await expect(message.locator("a")).toHaveCount(1);
  await expect(message.getByRole("link",{name:"Safe link"})).toHaveAttribute("rel","noopener noreferrer");
  await expect(message.locator("img,script,iframe,style")).toHaveCount(0);
  await expect(message).toContainText("Image omitted: tracking");
  expect(await page.locator("body").getAttribute("data-injected")).toBeNull();
  expect(requested).toEqual([]);
  const checks = await new AxeBuilder({page}).include(".composer-wrap").withTags(["wcag2a","wcag2aa","wcag21aa"]).analyze();
  expect(checks.violations).toEqual([]);
});

test("channel mention picker creates authorized activity that updates when the mention is removed", async({browser})=>{
  const a=await browser.newContext(),b=await browser.newContext();
  try {
    const alice=await a.newPage(),bob=await b.newPage();
    await login(alice);await login(bob,"bob@acme.test");
    await alice.getByRole("button",{name:"Launch planning",exact:true}).click();
    await alice.getByRole("button",{name:"Mention a person",exact:true}).click();
    const picker=alice.getByRole("dialog");
    await expect(picker.getByRole("button",{name:"Bob Chen",exact:true})).toBeVisible();
    await expect(picker.getByRole("button",{name:"Sam Rivera",exact:true})).toHaveCount(0);
    await picker.getByRole("button",{name:"Close dialog"}).click();
    await alice.goto(`/?channel=${channel}`);
    await expect(alice.getByRole("heading",{name:"General standard",exact:true})).toBeVisible();
    const marker=`Mention ${Date.now()}`;
    await alice.getByRole("textbox",{name:"Message",exact:true}).fill(marker+" ");
    await alice.getByRole("button",{name:"Mention a person",exact:true}).click();
    await alice.getByRole("dialog").getByRole("button",{name:"Bob Chen",exact:true}).click();
    await expect(alice.getByRole("textbox",{name:"Message",exact:true})).toHaveValue(new RegExp("concord-mention:bbbbbbbb"));
    // Draft source, including recipient identity, survives reload before sending.
    await expect.poll(async()=> (await (await a.request.get(`http://localhost:4100/v1/channels/${channel}/draft`)).json()).body).toContain("concord-mention:bbbbbbbb");
    await alice.reload();
    await expect(alice.getByRole("textbox",{name:"Message",exact:true})).toHaveValue(new RegExp(marker));
    const recovered = alice.getByRole("textbox",{name:"Message",exact:true});
    await recovered.fill((await recovered.inputValue()).replace("@Bob Chen","@Spoofed label").replace("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB"));
    await bob.getByRole("button",{name:"Activity",exact:true}).click();
    await bob.getByLabel("Activity filter").selectOption("mentions");
    await alice.getByRole("button",{name:"Send message",exact:true}).click();
    const activity=bob.locator(".result-card").filter({hasText:marker});
    await expect(activity).toBeVisible({timeout:12000});
    await expect(activity.locator(".formatted-message .mention")).toHaveText("@Bob Chen");
    await expect(activity.getByText("Mentioned you",{exact:true})).toBeVisible();
    await bob.screenshot({path:"docs/evidence/mention-activity.png"});
    const sent=alice.locator("article").filter({hasText:marker});
    await sent.hover();await sent.getByRole("button",{name:"Edit message",exact:true}).click();
    await alice.getByRole("dialog").getByRole("textbox",{name:"Message",exact:true}).fill(marker+" mention withdrawn");
    await alice.getByRole("button",{name:"Save changes",exact:true}).click();
    await expect(activity).toHaveCount(0,{timeout:12000});
    await bob.reload();
    await bob.getByRole("button",{name:"Activity",exact:true}).click();
    await bob.getByLabel("Activity filter").selectOption("mentions");
    await expect(bob.locator(".result-card").filter({hasText:marker})).toHaveCount(0);
  } finally {await a.close();await b.close();}
});
