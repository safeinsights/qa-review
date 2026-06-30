// src/suites/agreements-back.ts
var agreementsBackSuite = {
  name: "agreements-back",
  description: "View a Code-draft study, go Back to the Agreements step, and verify the Data use agreement and IRB protocol sections render",
  roles: ["researcher"],
  async run(ctx) {
    await ctx.step("Open the dashboard and confirm it loaded", async () => {
      await ctx.page.goto(`${ctx.baseURL}/dashboard`, { waitUntil: "domcontentloaded" });
      await ctx.page.getByRole("heading", { name: "My dashboard" }).waitFor({ state: "visible" });
      await ctx.page.getByRole("heading", { name: "My studies" }).waitFor({ state: "visible" });
    });
    await ctx.step("Find a Code-draft study and view it", async () => {
      const row = ctx.page.getByRole("row").filter({ hasText: "Code draft" }).first();
      await row.waitFor({ state: "visible" });
      await row.getByRole("link", { name: /^View details for study/i }).click();
      await ctx.page.waitForURL(/\/study\/[0-9a-f-]+\/code$/i);
      await ctx.page.getByRole("heading", { name: "Study code" }).waitFor({ state: "visible" });
    });
    await ctx.step("Click Previous to reach the Agreements step", async () => {
      await ctx.page.getByRole("link", { name: "Previous" }).click();
      await ctx.page.waitForURL(/\/study\/[0-9a-f-]+\/agreements\/researcher$/i);
    });
    await ctx.step("Verify the Data use agreement and IRB protocol sections are shown", async () => {
      await ctx.page.getByRole("heading", { name: "Study request" }).waitFor({ state: "visible" });
      await ctx.page.getByRole("heading", { name: "Data use agreement" }).waitFor({ state: "visible" });
      await ctx.page.getByRole("heading", { name: "IRB protocol" }).waitFor({ state: "visible" });
    });
  }
};
export {
  agreementsBackSuite
};
