// src/suites/Load-dash.ts
var loadDashSuite = {
  name: "Load-dash",
  description: "Verify the researcher personal dashboard loads",
  roles: ["researcher"],
  async run(ctx) {
    await ctx.step("Open the personal dashboard", async () => {
      await ctx.page.goto(`${ctx.baseURL}/dashboard`, { waitUntil: "domcontentloaded" });
      await ctx.page.getByRole("heading", { name: "My dashboard" }).waitFor({ state: "visible" });
    });
    await ctx.step("Verify the welcome message", async () => {
      await ctx.page.getByText(/Welcome to your personal dashboard/i).waitFor({ state: "visible" });
    });
    await ctx.step("Verify the studies table renders", async () => {
      await ctx.page.getByRole("heading", { name: "My studies" }).waitFor({ state: "visible" });
    });
  }
};
export {
  loadDashSuite
};
