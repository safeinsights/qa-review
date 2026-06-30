// src/suites/signin.ts
var signinSuite = {
  name: "signin",
  description: "Sign in and confirm the dashboard loads",
  roles: ["admin", "researcher", "reviewer"],
  async run(ctx) {
    await ctx.step("Confirm dashboard is visible", async () => {
      await ctx.page.locator("text=dashboard").first().waitFor({ state: "visible" });
    });
  }
};
export {
  signinSuite
};
