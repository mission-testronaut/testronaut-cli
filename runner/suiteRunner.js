export async function runSuite(objectives, sharedSetup) {
  const browser = await sharedSetup(); // e.g., login
  for (const { name, workflow } of objectives) {
    console.log(`\n🎯 Objective: ${name}`);
    await workflow(browser);
  }
  await browser.close();
}
