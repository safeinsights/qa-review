// src/suites/create-study.ts
var createStudySuite = {
  name: "create-study",
  description: "Create a study as a researcher, submit it, then clean it up",
  roles: ["researcher"],
  async run(ctx) {
    const title = `QA Test Study ${ctx.tag}`;
    await ctx.step("Open the researcher org dashboard", async () => {
      await ctx.page.goto(`${ctx.baseURL}/openstax-lab/dashboard`, { waitUntil: "domcontentloaded" });
      await ctx.page.getByRole("link", { name: /Propose New Study/i }).first().waitFor({ state: "visible" });
    });
    await ctx.step("Start a new study proposal", async () => {
      await ctx.page.getByRole("link", { name: /Propose New Study/i }).first().click();
      await ctx.page.waitForURL(/\/study\/request$/);
    });
    await ctx.step("Step 1: choose org and language", async () => {
      const orgSelect = ctx.page.getByTestId("org-select");
      await orgSelect.click();
      await ctx.page.getByRole("option", { name: /openstax/i }).first().click();
      const rRadio = ctx.page.getByRole("radio", { name: "R", exact: true });
      await rRadio.waitFor({ state: "visible" });
      await rRadio.click();
      await ctx.page.getByRole("button", { name: /Proceed to Step 2/i }).click();
    });
    const studyId = await ctx.step("Reach Step 2 and capture the study id", async () => {
      await ctx.page.waitForURL(/\/study\/[0-9a-f-]+\/proposal$/i);
      const match = ctx.page.url().match(/\/study\/([0-9a-f-]+)\/proposal/i);
      if (!match) throw new Error(`Could not find study id in proposal URL: ${ctx.page.url()}`);
      return match[1];
    });
    ctx.trackStudy(studyId);
    await ctx.step("Step 2: fill the proposal", async () => {
      await ctx.page.getByLabel("Study Title").fill(title);
      await ctx.page.getByPlaceholder("Select dataset(s) of interest").click();
      await ctx.page.getByRole("option").first().click();
      await fillLexical(ctx, "Research question(s)", "What is the impact of highlighting on student outcomes?");
      await fillLexical(ctx, "Project summary", "We analyze archival data to study highlighting behavior.");
      await fillLexical(ctx, "Impact", "This research will improve understanding of study habits.");
      const pi = ctx.page.getByRole("textbox", { name: "Principal Investigator" });
      await pi.click();
      await ctx.page.getByRole("option").first().click();
    });
    await ctx.step("Submit the initial request", async () => {
      await ctx.page.getByRole("button", { name: /Submit initial request/i }).click();
      await ctx.page.getByRole("button", { name: /Yes, submit initial request/i }).click();
      await ctx.page.getByText(/successfully submitted/i).waitFor({ state: "visible" });
    });
  }
};
async function fillLexical(ctx, ariaLabel, text) {
  const field = ctx.page.locator(`[aria-label="${ariaLabel}"]`);
  await field.click();
  await ctx.page.keyboard.type(text);
}
export {
  createStudySuite
};
