// src/suites/click-lab.ts
var clickLabSuite = {
  name: "click-lab",
  description: "Click the research lab nav link and confirm its dashboard loads",
  roles: ["researcher"],
  async run(ctx) {
    await ctx.step("Open the personal dashboard", async () => {
      await ctx.page.goto(`${ctx.baseURL}/dashboard`, { waitUntil: "domcontentloaded" });
      await ctx.page.getByRole("link", { name: /Research Lab/i }).first().waitFor({ state: "visible" });
    });
    await ctx.step("Click the research lab nav link", async () => {
      await ctx.page.getByRole("link", { name: /Research Lab/i }).first().click();
      await ctx.page.waitForURL(/\/openstax-lab\/dashboard$/);
    });
  }
};
export {
  clickLabSuite
};
