// Browser tests: the real site against the real Code.gs (running on the
// in-memory sheet in tests/sheet-mock.js). WebKit stands in for Safari on the
// iPad and iPhone; Chromium for Android.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure' },
  webServer: { command: 'node tests/serve.js', url: 'http://localhost:4173', reuseExistingServer: !process.env.CI },
  projects: [
    { name: 'ipad', use: { ...devices['iPad (gen 7)'] } },
    { name: 'iphone', use: { ...devices['iPhone 13'] } },
    { name: 'android', use: { ...devices['Pixel 7'] } },
  ],
});
